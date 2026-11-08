package main

import (
	"fmt"
	"log/slog"
	"os"
	"slices"
	"sync"
	"syscall"
	"time"
)

// Every backend death the gateway did not cause is filed — not only a death by
// a signal (crash_report.go). A backend that exits by CODE was assumed to have
// reported itself on the way out, but the process that dies is exactly the one
// whose own report is least likely to land: one that dies at boot before its
// reports engine is attached, one whose report has to reach the database it is
// dying of, or main, whose crashes on 2026-11-08 (exit 1 about every 10 s, 83
// times in 28 minutes) all folded into a four-day-old rate-limited rejection
// report, so nothing anywhere said "main is dying". The gateway is the one
// witness that outlives every such death: it holds the exit status, the
// process's own stderr, and the cadence of the deaths.
//
// So each unrequested death is one entry in the report outbox (the
// backend-crash writer): a signal death as `backend-crash`, an exit-code death
// as `backend-exit`. On top of the deaths — never instead of them — a
// worktree that keeps dying is a LOOP: `backend-crash-loop`, filed when
// crashLoopThreshold deaths land within crashLoopWindow of each other, again
// each time the loop's count doubles, and once more when it ends (no death
// for crashLoopWindow). Main's own loop waits in the outbox until a main
// backend lives long enough to drain it, as main's own crash does.

const (
	backendExitKind      = "backend-exit"
	backendCrashLoopKind = "backend-crash-loop"
)

// crashLoopThreshold deaths, each within crashLoopWindow of the previous one,
// make a loop. The 2026-11-08 loop died every 8-18 s; a worktree that dies
// three times in a few minutes is looping by any reading. A loop ends once
// crashLoopWindow passes with no further death.
const (
	crashLoopThreshold = 3
	crashLoopWindow    = 5 * time.Minute
)

// crashLoopRecentDeaths bounds the deaths a loop entry lists (the newest);
// its `deaths` count is the whole loop's.
const crashLoopRecentDeaths = 20

// backendExit is what the gateway saw of a backend that exited by code when
// nobody asked it to — the `backend-exit` payload.
type backendExit struct {
	Worktree string `json:"worktree"`
	Pid      int    `json:"pid"`
	ExitCode int    `json:"exitCode"`
	// StartedAt / ExitedAt: epoch ms of the spawn and of the death.
	StartedAt int64 `json:"startedAt"`
	ExitedAt  int64 `json:"exitedAt"`
	// ReadyAt: epoch ms it passed its readiness probe; null when it died
	// booting.
	ReadyAt    *int64   `json:"readyAt"`
	Executable string   `json:"executable"`
	StderrTail []string `json:"stderrTail"`
	// StderrComplete: the stderr pipe reached EOF (see backendCrash).
	StderrComplete bool `json:"stderrComplete"`
}

// loopDeath is one death of a loop, as its entry lists it.
type loopDeath struct {
	At int64 `json:"at"` // epoch ms
	// UpMs: how long that process lived.
	UpMs int64 `json:"upMs"`
	// Cause: `exit 1`, `SIGSEGV`.
	Cause string `json:"cause"`
	// Ready: it had passed its readiness probe (died serving, not booting).
	Ready bool `json:"ready"`
}

// backendCrashLoop is the `backend-crash-loop` payload: a worktree that keeps
// dying, as of one point in the loop.
type backendCrashLoop struct {
	Worktree string `json:"worktree"`
	// State: `looping` (filed as it dies) or `ended` (no death for WindowMs).
	State string `json:"state"`
	// Deaths: how many times it has died in this loop so far.
	Deaths int `json:"deaths"`
	// FirstDeathAt / LastDeathAt: epoch ms.
	FirstDeathAt int64 `json:"firstDeathAt"`
	LastDeathAt  int64 `json:"lastDeathAt"`
	// EndedAt: epoch ms the loop was declared over; null while looping.
	EndedAt *int64 `json:"endedAt"`
	// StateAtEnd: the worktree's backend state when the loop was declared
	// over (`running`: it stayed up; `idle`/`broken`: nothing restarted it);
	// null while looping.
	StateAtEnd *string `json:"stateAtEnd"`
	WindowMs   int64   `json:"windowMs"`
	Threshold  int     `json:"threshold"`
	// Recent: the newest deaths (at most crashLoopRecentDeaths), oldest first.
	Recent []loopDeath `json:"recent"`
	// LastStderrTail: the last death's stderr tail — what it died saying.
	LastStderrTail     []string `json:"lastStderrTail"`
	LastStderrComplete bool     `json:"lastStderrComplete"`
}

// backendDeath is how a backend the gateway did not stop ended, read off its
// wait status.
type backendDeath struct {
	signaled   bool
	sig        syscall.Signal
	coreDumped bool
	code       int
}

func (d backendDeath) cause() string {
	if d.signaled {
		return signalName(d.sig)
	}
	return fmt.Sprintf("exit %d", d.code)
}

// deathOf reads cmd.Wait's outcome. ok=false when the wait status cannot be
// read (no ProcessState) — the death is then logged, not filed.
func deathOf(ps *os.ProcessState) (backendDeath, bool) {
	if ps == nil {
		return backendDeath{}, false
	}
	ws, isWS := ps.Sys().(syscall.WaitStatus)
	if !isWS {
		return backendDeath{}, false
	}
	if ws.Signaled() {
		return backendDeath{signaled: true, sig: ws.Signal(), coreDumped: ws.CoreDump()}, true
	}
	return backendDeath{code: ws.ExitStatus()}, true
}

func newBackendExit(worktree string, pid, code int, startedAt, exitedAt int64, readyAt *int64, executable string, tail []string, complete bool) backendExit {
	if tail == nil {
		tail = []string{}
	}
	return backendExit{
		Worktree:       worktree,
		Pid:            pid,
		ExitCode:       code,
		StartedAt:      startedAt,
		ExitedAt:       exitedAt,
		ReadyAt:        readyAt,
		Executable:     executable,
		StderrTail:     tail,
		StderrComplete: complete,
	}
}

func msDuration(ms int64) time.Duration {
	return (time.Duration(ms) * time.Millisecond).Round(time.Second)
}

// exitMessage: `backend main exited with code 1 4s after ready (7s up)`, or
// `… while booting, after 3s`.
func exitMessage(e backendExit) string {
	head := fmt.Sprintf("backend %s exited with code %d", e.Worktree, e.ExitCode)
	if e.ReadyAt == nil {
		return fmt.Sprintf("%s while booting, after %s", head, msDuration(e.ExitedAt-e.StartedAt))
	}
	return fmt.Sprintf("%s %s after ready (%s up)", head,
		msDuration(e.ExitedAt-*e.ReadyAt), msDuration(e.ExitedAt-e.StartedAt))
}

// loopMessage: `backend main is crash-looping: 12 deaths in 1m40s (last: exit 1, 4s up)`,
// or `backend main's crash loop ended: …`.
func loopMessage(l backendCrashLoop) string {
	last := l.Recent[len(l.Recent)-1]
	tail := fmt.Sprintf("%d deaths in %s (last: %s, %s up)", l.Deaths,
		msDuration(l.LastDeathAt-l.FirstDeathAt), last.Cause, msDuration(last.UpMs))
	if l.State == "ended" {
		return fmt.Sprintf("backend %s's crash loop ended: %s; no death for %s since, now %s",
			l.Worktree, tail, msDuration(l.WindowMs), *l.StateAtEnd)
	}
	return fmt.Sprintf("backend %s is crash-looping: %s", l.Worktree, tail)
}

func entryOf(kind, message string, data any, occurredAt int64, checkout string) outboxEntry {
	return outboxEntry{
		Version:    1,
		Kind:       kind,
		Message:    message,
		Data:       data,
		OccurredAt: occurredAt,
		Writer:     outboxWriter{Pid: os.Getpid(), Checkout: checkout},
	}
}

// fileOutboxEntry writes e, logging the outcome. A failure is logged at error
// level: the gateway log is then the only record, and it says so.
func (w *Worktree) fileOutboxEntry(e outboxEntry) {
	if w.cfg.ReportOutboxDir == "" {
		slog.Error("backend death not reported: no report outbox is configured",
			"worktree", w.Name, "kind", e.Kind, "message", e.Message)
		return
	}
	path, err := writeOutboxEntry(w.cfg.ReportOutboxDir, e, time.Now())
	if err != nil {
		slog.Error("backend death could not be reported",
			"worktree", w.Name, "kind", e.Kind, "message", e.Message, "err", err)
		return
	}
	slog.Warn("backend death reported", "worktree", w.Name, "kind", e.Kind,
		"message", e.Message, "entry", path)
}

// reportBackendDeath files a death of bk the gateway did not cause: waits
// (bounded) for its stderr to reach EOF, files the death itself, then counts
// it toward a loop. Runs on its own goroutine, so the exit's state transition
// and a respawn never wait on it.
func (w *Worktree) reportBackendDeath(bk *backend, d backendDeath, exitedAt time.Time) {
	complete := true
	if bk.stderrDone != nil {
		select {
		case <-bk.stderrDone:
		case <-time.After(crashStderrGrace):
			complete = false
		}
	}
	tail := bk.stderrTail.lines()
	var readyAt *int64
	if r := bk.readyAt.Load(); r != 0 {
		readyAt = &r
	}
	if d.signaled {
		crash := newBackendCrash(w.Name, backendPID(bk), d.sig, d.coreDumped, bk.startedAt,
			exitedAt.UnixMilli(), bk.executable, tail, complete)
		w.fileOutboxEntry(newOutboxEntry(crash, os.Getpid(), bk.checkout))
	} else {
		exit := newBackendExit(w.Name, backendPID(bk), d.code, bk.startedAt, exitedAt.UnixMilli(),
			readyAt, bk.executable, tail, complete)
		w.fileOutboxEntry(entryOf(backendExitKind, exitMessage(exit), exit, exit.ExitedAt, bk.checkout))
	}
	death := loopDeath{
		At:    exitedAt.UnixMilli(),
		UpMs:  exitedAt.UnixMilli() - bk.startedAt,
		Cause: d.cause(),
		Ready: readyAt != nil,
	}
	if l, ok := w.loops.record(death, tail, complete, w.endCrashLoop); ok {
		w.fileOutboxEntry(entryOf(backendCrashLoopKind, loopMessage(l), l, l.LastDeathAt, bk.checkout))
	}
}

// endCrashLoop files a loop's last entry, once crashLoopWindow passed with no
// further death. checkout is the spec's server dir at that moment.
func (w *Worktree) endCrashLoop(l backendCrashLoop) {
	w.mu.Lock()
	state := w.phase.state().String()
	w.mu.Unlock()
	l.StateAtEnd = &state
	w.fileOutboxEntry(entryOf(backendCrashLoopKind, loopMessage(l), l, *l.EndedAt, w.Spec().Server))
}

// crashLoops tracks one worktree's recent deaths: the last one (to tell
// whether the next lands within the window) and the open loop, if any. Its own
// mutex; never held while filing.
type crashLoops struct {
	worktree  string
	window    time.Duration
	threshold int

	mu sync.Mutex
	// streak: deaths so far, each within window of the previous; a loop once
	// it reaches threshold.
	streak       int
	firstDeathAt int64
	// lastDeathAt: the latest death seen. Deaths arrive in the order their
	// reports finished (each waits up to crashStderrGrace for its stderr), not
	// strictly the order they died, so this is a max and recent is kept sorted.
	lastDeathAt  int64
	recent       []loopDeath
	lastTail     []string
	lastComplete bool
	// nextFileAt: the streak length at which the loop is filed next
	// (threshold, then doubling).
	nextFileAt int
	// timer fires window after the last death; gen tells a stale firing (a
	// death landed after it was armed) from the live one.
	timer *time.Timer
	gen   int
}

func newCrashLoops(worktree string) *crashLoops {
	return &crashLoops{worktree: worktree, window: crashLoopWindow, threshold: crashLoopThreshold}
}

// snapshot builds the payload under mu.
func (c *crashLoops) snapshot(state string) backendCrashLoop {
	return backendCrashLoop{
		Worktree:           c.worktree,
		State:              state,
		Deaths:             c.streak,
		FirstDeathAt:       c.firstDeathAt,
		LastDeathAt:        c.lastDeathAt,
		WindowMs:           c.window.Milliseconds(),
		Threshold:          c.threshold,
		Recent:             append([]loopDeath{}, c.recent...),
		LastStderrTail:     append([]string{}, c.lastTail...),
		LastStderrComplete: c.lastComplete,
	}
}

// record counts one death. Returns the loop entry to file now (the streak just
// reached threshold, or doubled since it was last filed), ok=false otherwise.
// onEnd is called — on the timer's goroutine — with the loop's last payload
// once window passes with no further death, when the streak was a loop.
func (c *crashLoops) record(d loopDeath, tail []string, complete bool, onEnd func(backendCrashLoop)) (backendCrashLoop, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.streak > 0 && d.At-c.lastDeathAt > c.window.Milliseconds() {
		// The window passed but its timer has not run yet: end the old streak
		// here (filing a loop's end), so this death starts a new one.
		if ended, ok := c.endedLocked(); ok {
			go onEnd(ended)
		}
		c.reset()
	}
	if c.streak == 0 {
		c.firstDeathAt, c.lastDeathAt = d.At, d.At
		c.nextFileAt = c.threshold
	}
	c.streak++
	c.firstDeathAt = min(c.firstDeathAt, d.At)
	c.lastDeathAt = max(c.lastDeathAt, d.At)
	i := len(c.recent)
	for i > 0 && c.recent[i-1].At > d.At {
		i--
	}
	c.recent = slices.Insert(c.recent, i, d)
	if len(c.recent) > crashLoopRecentDeaths {
		c.recent = c.recent[len(c.recent)-crashLoopRecentDeaths:]
	}
	c.lastTail, c.lastComplete = tail, complete

	if c.timer != nil {
		c.timer.Stop()
	}
	c.gen++
	gen := c.gen
	c.timer = time.AfterFunc(c.window, func() { c.expire(gen, onEnd) })

	if c.streak < c.nextFileAt {
		return backendCrashLoop{}, false
	}
	c.nextFileAt *= 2
	return c.snapshot("looping"), true
}

// expire ends the streak window after its last death; a loop files its end.
func (c *crashLoops) expire(gen int, onEnd func(backendCrashLoop)) {
	c.mu.Lock()
	if gen != c.gen || c.streak == 0 {
		c.mu.Unlock()
		return
	}
	ended, ok := c.endedLocked()
	c.reset()
	c.mu.Unlock()
	if ok {
		onEnd(ended)
	}
}

// endedLocked is the open streak's end entry, when the streak was a loop.
func (c *crashLoops) endedLocked() (backendCrashLoop, bool) {
	if c.streak < c.threshold {
		return backendCrashLoop{}, false
	}
	l := c.snapshot("ended")
	at := l.LastDeathAt + l.WindowMs
	l.EndedAt = &at
	return l, true
}

func (c *crashLoops) reset() {
	c.streak = 0
	c.recent = nil
	c.lastTail = nil
	c.lastComplete = false
	c.timer = nil
}
