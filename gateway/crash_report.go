package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

// A backend that dies by a signal runs nothing of its own on the way out: no
// exit listener, no crash sink, no report. Bun's crash handler prints its
// panic block (the fault, the bun.report link) to stderr and re-raises; the
// gateway is the one process that sees the death (cmd.Wait's wait status) and
// holds that stderr. So the gateway files it: one entry in the report outbox
// (reports/outbox), which main's backend drains into the reports table —
// immediately when another backend crashed, and on its next boot when the one
// that crashed was main itself. Before this, main segfaulted three times in
// two days (2026-11-06 → 11-08) and each one read as a silent restart.
//
// Any signal the gateway did not send counts, not only the faults (SEGV, BUS,
// ABRT, ILL): a kill from outside (jetsam, a person's kill -9) is also a
// backend gone without a word, and nothing else would report it. A SIGTERM
// from outside rarely reaches here: the backend handles it and exits by code.
//
// A grandchild that inherited the backend's stderr keeps the pipe (and its
// pump) open after the backend dies, its lines still landing in the log; that
// is what crashStderrGrace bounds for the report.
//
// An exit-code death is filed too, as `backend-exit`, and every unrequested
// death counts toward a crash loop: exit_report.go, where the one filing path
// (reportBackendDeath) lives.

// backendCrashKind is the report kind the entry is filed under. Declared by
// plugins/debug/plugins/backend-crash (core/kind.ts), which owns the payload's
// schema; testdata/backend-crash-entry.json pins this writer to it (both
// sides' tests read that one file).
const backendCrashKind = "backend-crash"

// crashTailLines is how much of the dead process's own stderr the report
// carries: Bun's crash block is ~20 lines, and what the process said just
// before it (a watcher error, a failed loader) is evidence too.
const crashTailLines = 60

// crashLineMaxBytes caps each tail line: the pump accepts lines up to 1 MB,
// and 60 of those would make one outbox file of 60 MB. A longer line keeps
// its first bytes and says it was cut.
const crashLineMaxBytes = 4096

// crashStderrGrace bounds the wait for the dead process's stderr to reach EOF.
// The panic block is the last thing it wrote and may still be in the pipe when
// the wait status arrives. A grandchild that inherited the pipe can hold it
// open for as long as it lives, so the wait cannot be unbounded; past it the
// report says its tail may be cut short.
const crashStderrGrace = 2 * time.Second

// outboxMaxPending mirrors OUTBOX_MAX_PENDING (reports/outbox core): a full
// outbox means main has been down a long time, and the cap keeps the directory
// bounded by construction.
const outboxMaxPending = 1000

// outboxLoopReserve: the last slots under the cap only a crash-loop summary
// may take. A loop on main is exactly when nothing drains the outbox, and at
// one death every ~10 s its per-death entries fill the cap in under three
// hours; past this point each death is still logged (refused, at error), but
// the loop's own entries — its doublings and its end — still land.
const outboxLoopReserve = 50

// outboxCapFor is how many pending entries an entry of kind may join.
func outboxCapFor(kind string) int {
	if kind == backendCrashLoopKind {
		return outboxMaxPending
	}
	return outboxMaxPending - outboxLoopReserve
}

// outboxEntryName is the drain's complete-entry pattern (reports/outbox
// core/internal/entry.ts ENTRY_NAME): `<epoch ms>-<pid>-<random>.json`.
var outboxEntryName = regexp.MustCompile(`^\d+-\d+-[a-z0-9]+\.json$`)

// backendCrash is what the gateway saw of a backend that died by a signal it
// did not send — the `backend-crash` payload.
type backendCrash struct {
	Worktree     string `json:"worktree"`
	Pid          int    `json:"pid"`
	Signal       string `json:"signal"`       // e.g. "SIGSEGV"
	SignalNumber int    `json:"signalNumber"` // the platform's number for it
	CoreDumped   bool   `json:"coreDumped"`
	StartedAt    int64  `json:"startedAt"` // epoch ms of the spawn
	ExitedAt     int64  `json:"exitedAt"`  // epoch ms the gateway saw it die
	// Executable is the process's name (its binary's base name, e.g.
	// "equin · server · <namespace>"): what macOS names its crash report by.
	Executable string `json:"executable"`
	// StderrTail is the dead process's last stderr lines, oldest first.
	StderrTail []string `json:"stderrTail"`
	// StderrComplete: the stderr pipe reached EOF, so the tail is everything
	// the process wrote. False when something else still held the pipe past
	// crashStderrGrace.
	StderrComplete bool `json:"stderrComplete"`
}

// outboxEntry is one report outbox file (reports/outbox OutboxEntrySchema,
// version 1), of any kind the gateway files: Data is that kind's payload
// (backendCrash here, serviceDown in service_report.go). The writer leaves
// `writer.repo` and `code` out: no code is named (the evidence is a process's
// own output, not repo files), so the drain files it as is.
type outboxEntry struct {
	Version    int          `json:"version"`
	Kind       string       `json:"kind"`
	Message    string       `json:"message"`
	Data       any          `json:"data"`
	OccurredAt int64        `json:"occurredAt"`
	Writer     outboxWriter `json:"writer"`
}

type outboxWriter struct {
	Pid      int    `json:"pid"`
	Checkout string `json:"checkout"`
}

// signalName is the SIG… name of sig, or "signal <n>" for one the platform
// does not name.
func signalName(sig syscall.Signal) string {
	if name := unix.SignalName(sig); name != "" {
		return name
	}
	return fmt.Sprintf("signal %d", int(sig))
}

// newBackendCrash assembles the payload from what the exit goroutine knows.
func newBackendCrash(worktree string, pid int, sig syscall.Signal, coreDumped bool, startedAt, exitedAt int64, executable string, tail []string, complete bool) backendCrash {
	if tail == nil {
		tail = []string{}
	}
	return backendCrash{
		Worktree:       worktree,
		Pid:            pid,
		Signal:         signalName(sig),
		SignalNumber:   int(sig),
		CoreDumped:     coreDumped,
		StartedAt:      startedAt,
		ExitedAt:       exitedAt,
		Executable:     executable,
		StderrTail:     tail,
		StderrComplete: complete,
	}
}

// crashMessage is the report's one-line message: who died, of what, after how
// long, and Bun's own word on the fault when its panic line is in the tail.
func crashMessage(c backendCrash) string {
	uptime := time.Duration(c.ExitedAt-c.StartedAt) * time.Millisecond
	msg := fmt.Sprintf("backend %s died by %s after %s", c.Worktree, c.Signal, uptime.Round(time.Second))
	for _, line := range c.StderrTail {
		if p := strings.TrimSpace(line); strings.HasPrefix(p, "panic:") {
			msg += " — " + p
			break
		}
	}
	return msg
}

// newOutboxEntry wraps a crash as an outbox entry from this gateway.
func newOutboxEntry(c backendCrash, gatewayPid int, checkout string) outboxEntry {
	return outboxEntry{
		Version:    1,
		Kind:       backendCrashKind,
		Message:    crashMessage(c),
		Data:       c,
		OccurredAt: c.ExitedAt,
		Writer:     outboxWriter{Pid: gatewayPid, Checkout: checkout},
	}
}

// writeOutboxEntry writes one entry into dir the way the TS writer does: under
// a dot-prefixed temp name, then renamed into place, so the drain never reads
// half a file. Refuses (an error) when the outbox already holds
// its kind's cap (outboxCapFor). Returns the entry's path.
func writeOutboxEntry(dir string, e outboxEntry, now time.Time) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	names, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	pending := 0
	for _, n := range names {
		if outboxEntryName.MatchString(n.Name()) {
			pending++
		}
	}
	if limit := outboxCapFor(e.Kind); pending >= limit {
		return "", fmt.Errorf("report outbox %s already holds %d entries (cap %d for %s): main has not drained it", dir, pending, limit, e.Kind)
	}
	body, err := json.Marshal(e)
	if err != nil {
		return "", err
	}
	name := fmt.Sprintf("%d-%d-%s.json", now.UnixMilli(), os.Getpid(), randomBase36(8))
	temp := filepath.Join(dir, "."+name+".tmp")
	path := filepath.Join(dir, name)
	if err := os.WriteFile(temp, body, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(temp, path); err != nil {
		_ = os.Remove(temp)
		return "", err
	}
	return path, nil
}

func randomBase36(n int) string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand does not fail on the platforms the gateway runs on; a
		// name is still unique by its ms + pid prefix within one writer.
		panic(fmt.Sprintf("crypto/rand: %v", err))
	}
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b)
}

// lineTail keeps the last few lines one stream of ONE process wrote. The
// worktree's logRing is shared by every process of the worktree, so a
// successor spawned while a crash is still being reported would mix its own
// lines into a time-bounded read of it.
type lineTail struct {
	mu  sync.Mutex
	max int
	buf []string
}

// lineCutSuffix ends a tail line cut at crashLineMaxBytes.
const lineCutSuffix = " …[cut]"

func newLineTail(max int) *lineTail { return &lineTail{max: max} }

// cutLine bounds one line at crashLineMaxBytes, marking a cut one.
func cutLine(line string) string {
	if len(line) <= crashLineMaxBytes {
		return line
	}
	cut := crashLineMaxBytes
	for cut > 0 && !utf8.RuneStart(line[cut]) {
		cut-- // never split a UTF-8 sequence
	}
	return line[:cut] + lineCutSuffix
}

func (t *lineTail) add(line string) {
	line = cutLine(line)
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, line)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
}

// lines returns a copy, oldest first; nil on a nil tail.
func (t *lineTail) lines() []string {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]string{}, t.buf...)
}
