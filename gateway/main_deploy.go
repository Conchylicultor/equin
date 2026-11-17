package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/fsnotify/fsnotify"
)

// ─── main's deploy, triggered from outside main ──────────────
//
// Main's auto-build used to live entirely inside main's own backend: the
// refs/heads/main watcher, the trigger, the debounce, the reconcile and the
// runner. So "main can serve" was a precondition for "main gets redeployed",
// and on 2026-11-08 a fix sat on main for eleven minutes while main had no
// backend, until a person reloaded this gateway.
//
// The gateway is the one process that is up whenever anything is, so the
// TRIGGER lives here — and only the trigger. It holds no policy: on an edge it
// starts ONE convergence run, `./equin build --allow-main --converge` from the
// code main serves — the main slot main's `current/<main namespace>` link names (-main-slots-current; the
// repo's checkout before any slot exists, see convergeDir) — which decides
// from durable state (git, the served dist, the build_runs ledger) whether
// anything is due and builds it, each build in a slot of its own
// (plugins/build/plugins/converge, plugins/infra/plugins/git/plugins/main-slots).
//
// The edges:
//   - refs/heads/main advanced (loose ref or packed-refs), trailing-debounced;
//   - this gateway booted;
//   - a backend asked (POST /gateway/deploy/converge: a composition config
//     change, a composition's cadence tick);
//   - the previous run exited while an edge arrived — at most one run at a
//     time, and an edge during a run is remembered, never dropped.
//
// Nothing here retries. A run that fails is filed as a `main-deploy-failed`
// report (plugins/build/plugins/converge) and the next edge is the next try.
//
// The run is NOT killed when the gateway stops: it is a deploy, its builds
// restart backends through this gateway's successor, and EQUIN_BUILD_DETACHED
// keeps the CLI's orphan guard from exiting it when its parent goes. It runs
// in its own process group and writes straight into its log file (not a pipe),
// so nothing it depends on dies with this process. The successor's boot edge
// starts a run that waits behind it on the checkout's build lock.

// mainDeployKind is the report kind a failed run is filed under. Declared by
// plugins/build/plugins/converge (core/kind.ts), which owns the payload's
// schema; testdata/main-deploy-failed-entry.json pins this writer to it.
const mainDeployKind = "main-deploy-failed"

// mainDeployDebounce coalesces a burst of pushes into one run: every edge moves
// the start to this long after it. Purely an optimisation — the run decides
// from durable state, so a coalesced edge loses nothing.
const mainDeployDebounce = 5 * time.Second

// mainRefRecheck is the backstop for a ref event the watch missed: the ref is
// re-read this often and a change is an edge. The watch is the fast path; this
// is the registry's watch+reconcile pattern (registry.go), for the same reason
// — a missed event would leave a pushed fix undeployed, the exact failure this
// file exists to end. Two small file reads per tick.
const mainRefRecheck = 30 * time.Second

// deployLogsSubdir is where the run log lives under -log-dir — a subdir, so
// the boot sweep of dead namespaces' `<name>.log` never takes it
// (namespace_logs.go). Pinned to DEPLOY_LOGS_SUBDIR (launcher/gateway-logs) by
// gateway-logs:in-sync.
const deployLogsSubdir = "deploy"

// mainDeployLogMax bounds the run log: past it the log is rotated to `.1`
// before the next run starts (the run's own fd keeps writing the old file).
const mainDeployLogMax = 16 << 20

// mainDeployMaxCauses bounds the causes one run records.
const mainDeployMaxCauses = 16

// mainDeployFailed is the `main-deploy-failed` payload.
type mainDeployFailed struct {
	ExitCode   *int     `json:"exitCode"`
	Signal     *string  `json:"signal"`
	SpawnError *string  `json:"spawnError"`
	Causes     []string `json:"causes"`
	Tail       []string `json:"tail"`
	Checkout   string   `json:"checkout"`
	Log        string   `json:"log"`
	StartedAt  int64    `json:"startedAt"`
	EndedAt    int64    `json:"endedAt"`
}

// mainDeployStatus is GET /gateway/deploy's answer.
type mainDeployStatus struct {
	Checkout string `json:"checkout"`
	// Ref is the last refs/heads/main value seen ("" before the first read).
	Ref     string   `json:"ref"`
	Running bool     `json:"running"`
	Pid     int      `json:"pid,omitempty"`
	Pending []string `json:"pending"`
	Last    *struct {
		Causes    []string `json:"causes"`
		StartedAt int64    `json:"startedAt"`
		EndedAt   int64    `json:"endedAt"`
		Outcome   string   `json:"outcome"`
	} `json:"last"`
}

// mainDeployer runs main's convergence: one child at a time, started by edges.
type mainDeployer struct {
	checkout string
	// currentSlot is main's own `current/<main namespace>` link in its slot pool
	// (plugins/infra/plugins/git/plugins/main-slots): each run starts in the
	// slot it names. "" (a hand-run gateway with no pool) always runs in
	// checkout.
	currentSlot string
	gitDir      string
	env         ChildEnv
	logPath     string
	outboxDir   string
	debounce    time.Duration
	// spawner starts the run as a long-lived child (spawn.go): under the
	// keeper, a generation that replaces this one adopts it.
	spawner spawner

	// spawn starts the run, its output appended to logPath; a field so tests
	// can stand in a fake command.
	spawn func(logPath string, tag json.RawMessage) (*child, error)
	// gate: a handover freezes the start of a run (handover.go); nil admits.
	gate *lifecycleGate

	mu      sync.Mutex
	ref     string
	running *child
	// pending holds the causes of edges not yet given to a run: waiting out
	// the debounce, or arrived while a run was going.
	pending []string
	timer   *time.Timer
	last    *struct {
		Causes    []string `json:"causes"`
		StartedAt int64    `json:"startedAt"`
		EndedAt   int64    `json:"endedAt"`
		Outcome   string   `json:"outcome"`
	}
	// done is closed when a run exits (tests wait on it).
	runEnded chan struct{}
}

// newMainDeployer validates main's checkout: a gateway told to deploy a
// checkout that is not one fails at boot, naming it, rather than at the first
// push. The checkout is the git store (its refs/heads/main is watched) and
// the fallback a run starts in; currentSlot is where runs start once main is
// served from a slot.
func newMainDeployer(checkout, currentSlot string, env ChildEnv, logDir, outboxDir string) (*mainDeployer, error) {
	gitDir := filepath.Join(checkout, ".git")
	info, err := os.Stat(gitDir)
	if err != nil {
		return nil, fmt.Errorf("-main-checkout %s: %w", checkout, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("-main-checkout %s: .git is not a directory — that is a linked worktree, not main's checkout", checkout)
	}
	cli := filepath.Join(checkout, "equin")
	if _, err := os.Stat(cli); err != nil {
		return nil, fmt.Errorf("-main-checkout %s: no CLI at %s: %w", checkout, cli, err)
	}
	d := &mainDeployer{
		spawner:     localSpawner{},
		checkout:    checkout,
		currentSlot: currentSlot,
		gitDir:      gitDir,
		env:         env,
		logPath:     filepath.Join(logDir, deployLogsSubdir, "main.log"),
		outboxDir:   outboxDir,
		debounce:    mainDeployDebounce,
		runEnded:    make(chan struct{}, 1),
	}
	d.spawn = func(logPath string, tag json.RawMessage) (*child, error) {
		// Resolved before EVERY run: a build moves `current` to the slot it
		// deployed, and the next run must start from that one.
		dir, err := convergeDir(checkout, currentSlot)
		if err != nil {
			return nil, err
		}
		slog.Info("main deploy: convergence run starts", "dir", dir)
		return d.spawner.spawn(spawnSpec{
			Argv: []string{filepath.Join(dir, "equin"), "build", "--allow-main", "--converge"},
			Dir:  dir,
			// The CLI's orphan guard exits a command whose parent dies; this run
			// must outlive a gateway restart (see the header).
			Env:    env.With(envPrefix + "BUILD_DETACHED=1"),
			Stdout: outputTo{Path: logPath},
			Stderr: outputTo{Path: logPath},
			Tag:    tag,
		})
	}
	return d, nil
}

// convergeDir is where a convergence run starts: the slot `current` names,
// resolved (so the run's cwd is the slot itself, not the link a later build
// re-points), or the repo's checkout while there is no `current` — before
// main's first slot build, or with no pool configured. A `current` that is a
// link to a slot no longer on disk falls back too, with a warning: the run
// from the checkout builds a slot again. Any other error is the run's
// failure, reported like one.
func convergeDir(checkout, current string) (string, error) {
	if current == "" {
		return checkout, nil
	}
	dir, err := filepath.EvalSymlinks(current)
	if err == nil {
		return dir, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("resolve main's current slot %s: %w", current, err)
	}
	if _, lerr := os.Lstat(current); lerr == nil {
		slog.Warn("main deploy: current names a slot that is gone; running from the checkout", "current", current, "checkout", checkout)
	}
	return checkout, nil
}

// Start sets up the refs/heads/main watch — an error here fails the boot — then
// fires the boot edge and keeps watching until ctx ends.
//
// inherited is a predecessor's state (a handover): its pending edges carry
// over and there is no boot edge — this is not a boot, and the run the
// predecessor may have going was adopted (adoptRun).
func (d *mainDeployer) Start(ctx context.Context, inherited *deployState) error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	// The loose ref's directory (git renames main.lock onto main) and the git
	// dir itself (packed-refs is rewritten the same way by gc / pack-refs).
	for _, dir := range []string{filepath.Join(d.gitDir, "refs", "heads"), d.gitDir} {
		if err := w.Add(dir); err != nil {
			_ = w.Close()
			return fmt.Errorf("watch %s: %w", dir, err)
		}
	}
	if inherited != nil {
		d.mu.Lock()
		d.ref = inherited.Ref
		d.mu.Unlock()
		for _, c := range inherited.Pending {
			d.Trigger(c)
		}
		d.recheckRef("ref advanced during a gateway handover")
	} else {
		d.recheckRef("") // record the starting value; the boot edge covers it
		d.Trigger("gateway boot")
	}
	go d.watch(ctx, w)
	return nil
}

func (d *mainDeployer) watch(ctx context.Context, w *fsnotify.Watcher) {
	defer w.Close()
	tick := time.NewTicker(mainRefRecheck)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			d.mu.Lock()
			if d.timer != nil {
				d.timer.Stop()
			}
			d.mu.Unlock()
			return
		case _, ok := <-w.Events:
			if !ok {
				return
			}
			// ANY event in the two dirs re-reads the ref, not only one naming
			// refs/heads/main or packed-refs: kqueue coalesces a directory's
			// changes, so two pushes' lock-and-rename in quick succession can
			// arrive as the first one's events alone (measured in
			// TestMainDeployWatchesRefsHeadsMain). The value comparison is what
			// decides an edge; a re-read is one small file.
			d.recheckRef("ref advanced")
		case werr, ok := <-w.Errors:
			if !ok {
				return
			}
			slog.Warn("main deploy: ref watch error", "err", werr)
		case <-tick.C:
			d.recheckRef("ref advanced (recheck)")
		}
	}
}

// recheckRef reads refs/heads/main and, when it moved and cause is set,
// fires an edge. An unreadable ref is logged, never an edge.
func (d *mainDeployer) recheckRef(cause string) {
	ref, err := readMainRef(d.gitDir)
	if err != nil {
		slog.Warn("main deploy: cannot read refs/heads/main", "err", err)
		return
	}
	d.mu.Lock()
	moved := ref != d.ref
	prev := d.ref
	d.ref = ref
	d.mu.Unlock()
	if moved && cause != "" {
		slog.Info("main deploy: refs/heads/main advanced", "from", prev, "to", ref)
		d.Trigger(cause)
	}
}

// readMainRef resolves refs/heads/main the way git does for a ref that is not
// symbolic: the loose file when there is one, else its packed-refs line.
func readMainRef(gitDir string) (string, error) {
	b, err := os.ReadFile(filepath.Join(gitDir, "refs", "heads", "main"))
	if err == nil {
		return strings.TrimSpace(string(b)), nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	f, err := os.Open(filepath.Join(gitDir, "packed-refs"))
	if err != nil {
		return "", err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		sha, name, ok := strings.Cut(sc.Text(), " ")
		if ok && name == "refs/heads/main" {
			return sha, nil
		}
	}
	if err := sc.Err(); err != nil {
		return "", err
	}
	return "", fmt.Errorf("refs/heads/main is in neither %s/refs/heads nor packed-refs", gitDir)
}

// Trigger records an edge. With no run going, the run starts once edges have
// been quiet for the debounce; with one going, the edge waits for it to end.
func (d *mainDeployer) Trigger(cause string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.pending) < mainDeployMaxCauses {
		d.pending = append(d.pending, cause)
	}
	if d.running != nil {
		return
	}
	d.armLocked()
}

func (d *mainDeployer) armLocked() {
	if d.timer != nil {
		d.timer.Stop()
	}
	d.timer = time.AfterFunc(d.debounce, d.start)
}

// start runs the pending edges' convergence, unless a run already goes. A
// handover in progress defers it (the edges travel to the successor, or run
// here once the handover is abandoned).
func (d *mainDeployer) start() {
	if !d.gate.open() {
		if d.gate.isReplaced() {
			return
		}
		d.mu.Lock()
		d.armLocked()
		d.mu.Unlock()
		return
	}
	d.mu.Lock()
	if d.running != nil || len(d.pending) == 0 {
		d.mu.Unlock()
		return
	}
	causes := d.pending
	d.pending = nil
	startedAt := time.Now()

	offset, err := d.openLog()
	var c *child
	if err == nil {
		tag, _ := json.Marshal(childTag{Kind: childDeployRun, Causes: causes, StartedAt: startedAt.UnixMilli(), LogOffset: offset})
		c, err = d.spawn(d.logPath, tag)
	}
	if err != nil {
		d.mu.Unlock()
		slog.Error("main deploy: could not start the convergence run", "causes", causes, "err", err)
		msg := err.Error()
		d.finish(causes, startedAt, mainDeployFailed{SpawnError: &msg}, offset)
		return
	}
	d.running = c
	d.mu.Unlock()
	slog.Info("main deploy: convergence run started", "pid", c.Pid, "causes", causes, "log", d.logPath)
	go d.await(c, causes, startedAt, offset)
}

// await waits for a run to end and records how it did.
func (d *mainDeployer) await(c *child, causes []string, startedAt time.Time, offset int64) {
	<-c.done
	st := c.status
	var f mainDeployFailed
	switch {
	case st.success():
	case st.Err != "":
		msg := st.Err
		f.SpawnError = &msg
	case st.Signaled:
		sig := signalName(syscall.Signal(st.Signal))
		f.Signal = &sig
	default:
		code := st.Code
		f.ExitCode = &code
	}
	d.mu.Lock()
	d.running = nil
	d.mu.Unlock()
	if d.gate.isReplaced() {
		return // the successor adopted this run and records it
	}
	if st.success() {
		slog.Info("main deploy: convergence run finished", "causes", causes)
		d.finish(causes, startedAt, mainDeployFailed{}, -1)
	} else {
		slog.Error("main deploy: convergence run failed", "causes", causes, "status", st, "log", d.logPath)
		d.finish(causes, startedAt, f, offset)
	}
}

// adoptRun takes over a run the predecessor started (adopt.go).
func (d *mainDeployer) adoptRun(c *child, tag childTag) {
	d.mu.Lock()
	d.running = c
	d.mu.Unlock()
	slog.Info("main deploy: adopted the convergence run in progress", "pid", c.Pid, "causes", tag.Causes)
	go d.await(c, tag.Causes, time.UnixMilli(tag.StartedAt), tag.LogOffset)
}

// exportState is what a successor needs to carry on: the ref seen and the
// edges not yet given to a run.
func (d *mainDeployer) exportState() *deployState {
	d.mu.Lock()
	defer d.mu.Unlock()
	return &deployState{Ref: d.ref, Pending: append([]string{}, d.pending...)}
}

// finish records a run's end, files a failure, and starts the run edges that
// arrived meanwhile asked for. offset < 0 means it succeeded.
func (d *mainDeployer) finish(causes []string, startedAt time.Time, f mainDeployFailed, offset int64) {
	endedAt := time.Now()
	outcome := "ok"
	if offset >= 0 {
		outcome = "failed"
		f.Causes = causes
		f.Tail = readTailFrom(d.logPath, offset)
		f.Checkout = d.checkout
		f.Log = d.logPath
		f.StartedAt = startedAt.UnixMilli()
		f.EndedAt = endedAt.UnixMilli()
		d.report(f)
	}
	d.mu.Lock()
	d.last = &struct {
		Causes    []string `json:"causes"`
		StartedAt int64    `json:"startedAt"`
		EndedAt   int64    `json:"endedAt"`
		Outcome   string   `json:"outcome"`
	}{causes, startedAt.UnixMilli(), endedAt.UnixMilli(), outcome}
	if len(d.pending) > 0 {
		d.armLocked()
	}
	d.mu.Unlock()
	select {
	case d.runEnded <- struct{}{}:
	default:
	}
}

// openLog opens the run log for appending, rotating it first when it is past
// its bound, and returns where this run's output starts.
func (d *mainDeployer) openLog() (int64, error) {
	f, offset, err := d.openLogFile()
	if err != nil {
		return 0, err
	}
	return offset, f.Close()
}

func (d *mainDeployer) openLogFile() (*os.File, int64, error) {
	if info, err := os.Stat(d.logPath); err == nil && info.Size() > mainDeployLogMax {
		if err := os.Rename(d.logPath, d.logPath+".1"); err != nil {
			return nil, 0, err
		}
	}
	if err := os.MkdirAll(filepath.Dir(d.logPath), 0o755); err != nil {
		return nil, 0, err
	}
	f, err := os.OpenFile(d.logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, 0, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, 0, err
	}
	fmt.Fprintf(f, "\n── gateway %d: convergence run at %s ──\n", os.Getpid(), time.Now().Format(time.RFC3339))
	return f, info.Size(), nil
}

// readTailFrom returns the last crashTailLines lines written to path from
// offset on, each cut to crashLineMaxBytes. A read failure is the tail's one
// line: the report still files, and says what it could not read.
func readTailFrom(path string, offset int64) []string {
	f, err := os.Open(path)
	if err != nil {
		return []string{fmt.Sprintf("(could not read %s: %v)", path, err)}
	}
	defer f.Close()
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return []string{fmt.Sprintf("(could not seek %s: %v)", path, err)}
	}
	t := newLineTail(crashTailLines)
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		t.add(sc.Text())
	}
	return t.lines()
}

// mainDeployMessage is the entry's one-line message.
func mainDeployMessage(f mainDeployFailed) string {
	how := "failed"
	switch {
	case f.SpawnError != nil:
		how = "could not start: " + *f.SpawnError
	case f.Signal != nil:
		how = "was killed by " + *f.Signal
	case f.ExitCode != nil:
		how = fmt.Sprintf("failed (exit %d)", *f.ExitCode)
	}
	return fmt.Sprintf("main's convergence run %s — started by %s", how, strings.Join(f.Causes, ", "))
}

func newMainDeployEntry(f mainDeployFailed, gatewayPid int) outboxEntry {
	return outboxEntry{
		Version:    1,
		Kind:       mainDeployKind,
		Message:    mainDeployMessage(f),
		Data:       f,
		OccurredAt: f.EndedAt,
		Writer:     outboxWriter{Pid: gatewayPid, Checkout: f.Checkout},
	}
}

// report files a failed run. A failure to file is logged at error — the
// gateway log is then the only record, and it says so.
func (d *mainDeployer) report(f mainDeployFailed) {
	if d.outboxDir == "" {
		slog.Error("main deploy: run failed and no report outbox is configured; not reported")
		return
	}
	path, err := writeOutboxEntry(d.outboxDir, newMainDeployEntry(f, os.Getpid()), time.Now())
	if err != nil {
		slog.Error("main deploy: run failed and its report could not be filed", "err", err)
		return
	}
	slog.Warn("main deploy: failed run reported", "entry", path)
}

// Status is the deployer's state, for GET /gateway/deploy.
func (d *mainDeployer) Status() mainDeployStatus {
	d.mu.Lock()
	defer d.mu.Unlock()
	s := mainDeployStatus{
		Checkout: d.checkout,
		Ref:      d.ref,
		Running:  d.running != nil,
		Pending:  append([]string{}, d.pending...),
		Last:     d.last,
	}
	if d.running != nil {
		s.Pid = d.running.Pid
	}
	return s
}
