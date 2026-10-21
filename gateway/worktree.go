package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// macOS sun_path is 104 bytes; Linux is 108. We pick the tighter limit so
// developer machines and CI agree.
const maxSocketPath = 104

// State is the lifecycle state of a worktree's backend process.
type State int

const (
	StateIdle State = iota
	StateStarting
	StateRunning
	StateRestarting
	StateStopping
	StateBroken
)

func (s State) String() string {
	switch s {
	case StateIdle:
		return "idle"
	case StateStarting:
		return "starting"
	case StateRunning:
		return "running"
	case StateRestarting:
		return "restarting"
	case StateStopping:
		return "stopping"
	case StateBroken:
		return "broken"
	default:
		return "unknown"
	}
}

// Spec is the on-disk schema parsed from ~/.singularity/worktrees/<name>/spec.json.
type Spec struct {
	Server  string   `json:"server"`            // absolute path to the backend's working directory (cwd)
	Web     string   `json:"web"`               // absolute path to web/dist
	Command []string `json:"command,omitempty"` // optional: argv to spawn (release: compiled server binary). When empty, falls back to the bun convention.

	// Composition names WHICH APP this namespace serves. The gateway neither
	// interprets it nor hands it on: the BACKEND reads it back off this same
	// spec.json at boot (server-core/bin/spec-composition.ts) and picks its
	// plugin registry from it. Absent means "no composition was declared",
	// which the backend reads as the main app — never as "look on disk and see
	// what turns up", which is the presence-keyed selection this field replaced.
	//
	// It is on this struct because it is part of the on-disk contract and the
	// gateway round-trips a spec: dropping an unknown field here would erase it.
	// Carried, not decomposed — exactly like Name.
	//
	// Deliberately NOT passed as an env var to the spawned backend. `singularity
	// build` does not rebuild this Go binary (only `singularity start` does), so
	// a running gateway is routinely older than the backend it spawns; a backend
	// that depended on a new env line would silently fall back to the full
	// registry and boot the whole app under a composition's own namespace and
	// database. Reading the file the gateway already read removes the hop that
	// could drop the value, and the two cannot drift.
	//
	// Omitted from the JSON when empty so a spec that declares no composition
	// serializes as it always did.
	Composition string `json:"composition,omitempty"`

	// rev identifies the spec.json revision this value was parsed from. It rides
	// INSIDE Spec — rather than as a sibling field on Worktree — so a spec and
	// the fingerprint asserting "this is what's on disk" travel through the same
	// atomic pointer and can never disagree. Unexported, so json.Unmarshal never
	// touches it and it never appears on the wire. A hand-constructed Spec has
	// the zero rev, which compares equal to no real file revision.
	rev specRev
}

// specRev fingerprints one revision of a spec.json. Comparable with ==; the
// zero value means "revision unknown".
//
// Detection is keyed on (mtime, size, dev, ino). mtime alone is not enough: the
// writer replaces spec.json by an atomic temp+rename, so on a filesystem with
// coarse (1s) mtime granularity two rewrites within the same second and of the
// same length would be indistinguishable. That same rename is what makes the
// inode decisive — a renamed-into-place file is always a NEW inode, so the pair
// covers both the nanosecond-mtime case (APFS, ext4) and the coarse one. dev is
// carried alongside ino because inode numbers are only unique per device.
//
// A content hash would also be exact, but costs a read of every spec on every
// reconcile tick (measured ~10x the stat) to answer a question the stat already
// answers for the one writer that exists.
type specRev struct {
	mtimeNs int64
	size    int64
	dev     uint64
	ino     uint64
}

// specRevOf derives the fingerprint from a stat result. dev/ino come from the
// platform stat struct when available; where it is not, the fingerprint
// degrades to (mtime, size), which is still exact on any nanosecond-mtime
// filesystem.
func specRevOf(fi os.FileInfo) specRev {
	rev := specRev{mtimeNs: fi.ModTime().UnixNano(), size: fi.Size()}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		rev.dev = uint64(st.Dev)
		rev.ino = uint64(st.Ino)
	}
	return rev
}

// WorktreeStatus is the public projection of a worktree's state, returned by
// /gateway/worktrees and used by the dashboard plugin.
type WorktreeStatus struct {
	Name         string    `json:"name"`
	State        string    `json:"state"`
	SocketPath   string    `json:"socketPath"`
	LastActivity time.Time `json:"lastActivity"`
	ActiveConns  int       `json:"activeConns"`
	Server       string    `json:"server"`
	Web          string    `json:"web"`
	// LastSpawnErr is the last spawn/readiness failure, empty when none. Lets a
	// consumer (the build CLI) distinguish a real boot crash from a slow boot.
	LastSpawnErr string `json:"lastSpawnErr"`
}

var (
	ErrBroken      = errors.New("worktree in broken cooldown")
	ErrSpawnFailed = errors.New("backend spawn failed")
	ErrStopping    = errors.New("worktree is stopping")
)

// StartReason is why a caller may start the backend, which sets the spawn's
// priority. Every Ensure names one, so no start path can pick a priority by
// omission.
type StartReason int

const (
	// StartBackground: nobody is watching this boot — an agent's MCP call, a
	// script, another server, a deploy. Spawned darwinbg (when the host
	// supports it) so the boot burst stays off the cores the user is on;
	// promoted once ready, or on escalation.
	StartBackground StartReason = iota
	// StartBrowser: a browser is waiting on this backend — a document load or
	// the app's WebSocket (an agent's Playwright browser included). Spawned at
	// default priority; joining an in-flight background spawn promotes it.
	StartBrowser
)

func (r StartReason) String() string {
	if r == StartBrowser {
		return "browser"
	}
	return "background"
}

// backend groups the per-process fields for one running backend instance.
// A Worktree holds at most one active *backend; a second may exist briefly
// as the "draining" old backend during a hot restart.
type backend struct {
	cmd        *exec.Cmd
	exitCh     chan struct{} // closed when cmd.Wait returns
	startedAt  int64         // epoch ms of spawn; bounds the stderr tail an early exit reports
	socketPath string
	proxy      *httputil.ReverseProxy // nil until waitReady succeeds
	demoted    bool                   // running darwinbg (taskpolicy -b) until promoted; guarded by the owning Worktree's mu

	// connMu guards both connection counters. httpConns tracks in-flight HTTP
	// requests — bounded, short-lived, and waited on at drain so they finish
	// cleanly instead of resetting into a 502. wsConns tracks WebSocket
	// connections (live-state, terminal, logs) — long-lived, never close on
	// their own, so they are NOT waited on at drain; clients reconnect.
	connMu    sync.Mutex
	httpConns int
	wsConns   int
}

func (b *backend) incHTTP() {
	b.connMu.Lock()
	b.httpConns++
	b.connMu.Unlock()
}

func (b *backend) decHTTP() {
	b.connMu.Lock()
	if b.httpConns > 0 {
		b.httpConns--
	}
	b.connMu.Unlock()
}

func (b *backend) incWS() {
	b.connMu.Lock()
	b.wsConns++
	b.connMu.Unlock()
}

func (b *backend) decWS() {
	b.connMu.Lock()
	if b.wsConns > 0 {
		b.wsConns--
	}
	b.connMu.Unlock()
}

func (b *backend) httpCount() int {
	b.connMu.Lock()
	defer b.connMu.Unlock()
	return b.httpConns
}

func (b *backend) wsCount() int {
	b.connMu.Lock()
	defer b.connMu.Unlock()
	return b.wsConns
}

// conns returns total active connections (in-flight HTTP + WebSocket). Used by
// the idle sweeper and status snapshot, which treat any activity as "busy".
func (b *backend) conns() int {
	b.connMu.Lock()
	defer b.connMu.Unlock()
	return b.httpConns + b.wsConns
}

// Worktree owns one backend's lifecycle: spawn, supervise, proxy, idle teardown.
type Worktree struct {
	Name string

	cfg *Config

	// spec is replaced atomically on file change. Lock-free reads.
	spec atomic.Pointer[Spec]

	// All other fields below are guarded by mu.
	mu           sync.Mutex
	state        State
	active       *backend
	lastActivity time.Time
	brokenUntil  time.Time
	readyCh      chan struct{} // signal-only; waiters re-check state
	lastSpawnErr error
	// browserJoined records that a StartBrowser caller joined the in-flight
	// spawn before its backend was published to active, so the spawner
	// promotes it on publish. Reset at each spawn.
	browserJoined bool

	// restartMu serializes concurrent Restart() calls.
	restartMu sync.Mutex
	// restartDone is non-nil during StateRestarting. Closed when restart
	// settles (success or failure). Snapshot under w.mu; closed by Restart().
	restartDone chan struct{}

	// logBuf is a per-worktree ring of backend stdout/stderr lines. It
	// persists across respawns so crash output remains visible after the
	// process exits. Its own mutex; not guarded by w.mu.
	logBuf *logRing

	// logFile is this worktree's own on-disk log channel (<name>.log). It is
	// the durable counterpart to logBuf, opened lazily on first write and
	// rotated by size. Its own mutex; not guarded by w.mu.
	logFile *rotatingWriter
}

func NewWorktree(name string, spec *Spec, cfg *Config) (*Worktree, error) {
	// Validate the longer .next.sock path — if it fits, the primary .sock does too.
	longest := filepath.Join(cfg.SocketsDir, name+".next.sock")
	if len(longest) > maxSocketPath {
		return nil, fmt.Errorf("socket path %q is %d bytes; exceeds %d-byte limit (rename worktree)", longest, len(longest), maxSocketPath)
	}
	w := &Worktree{
		Name:    name,
		cfg:     cfg,
		logBuf:  newLogRing(cfg.LogBufferLines),
		logFile: newRotatingWriter(filepath.Join(cfg.LogDir, name+".log"), maxLogBytes, maxLogBackups),
	}
	w.spec.Store(spec)
	return w, nil
}

// CloseLog closes the worktree's on-disk log channel. Called when the worktree
// is unregistered; the writer reopens lazily if the worktree is ever used again.
func (w *Worktree) CloseLog() {
	_ = w.logFile.Close()
}

// Spec returns the current spec snapshot. Lock-free.
func (w *Worktree) Spec() *Spec { return w.spec.Load() }

// UpdateSpec replaces the spec atomically. What each field's change costs:
//
//   - Web — live on the NEXT REQUEST. handleStatic reads wt.Spec().Web per
//     request, so a rewritten dist path takes effect with no respawn at all.
//     This is the field a build rewrites, and the reason a spec refresh is
//     worth doing at all.
//   - Server, Command — LAZY. They are read at spawn time
//     (Ensure/Restart both snapshot w.Spec() before startBackend), so a
//     running backend keeps the argv and cwd it was started with until it is
//     stopped and respawned. Refreshing the spec alone does not restart
//     anything; the build's write→restart sequence is what applies them, and
//     the /gateway/worktrees/<name>/restart handler refreshes the spec first
//     precisely so the restart it then performs uses the new values.
func (w *Worktree) UpdateSpec(s *Spec) {
	w.spec.Store(s)
}

// SpecRev returns the fingerprint of the spec.json revision the current spec
// was loaded from. The registry compares it against a fresh stat to decide
// whether a reload is needed.
func (w *Worktree) SpecRev() specRev { return w.spec.Load().rev }

func (w *Worktree) primarySocketPath() string {
	return filepath.Join(w.cfg.SocketsDir, w.Name+".sock")
}

func (w *Worktree) secondarySocketPath() string {
	return filepath.Join(w.cfg.SocketsDir, w.Name+".next.sock")
}

// restartTargetPath returns the socket path to use for the next hot restart.
// Picks whichever of primary/secondary the current active backend is NOT using.
// Must be called with w.mu held.
func (w *Worktree) restartTargetPath() string {
	if w.active != nil && w.active.socketPath == w.primarySocketPath() {
		return w.secondarySocketPath()
	}
	return w.primarySocketPath()
}

// Ensure starts the backend if needed and returns the active backend. The
// caller serves the request through bk.proxy; returning the backend (not just
// the proxy) lets HTTP/WS handlers count their connection against the exact
// process serving it, so drain waits on the right backend.
// Concurrent callers share a single in-flight spawn via readyCh. reason sets
// the priority of a spawn this call begins; a StartBrowser caller joining a
// background spawn promotes it at once.
func (w *Worktree) Ensure(ctx context.Context, reason StartReason) (*backend, error) {
	w.mu.Lock()

	switch w.state {
	case StateRunning:
		bk := w.active
		w.mu.Unlock()
		return bk, nil

	case StateRestarting:
		// Old backend still serving — return it for zero downtime.
		bk := w.active
		w.mu.Unlock()
		return bk, nil

	case StateStarting:
		ch := w.readyCh
		var joined *backend
		if reason == StartBrowser {
			// Before the spawner publishes its backend, the flag tells it to
			// promote on publish; after, we promote it ourselves. Both under
			// mu, so exactly one of the two sees the other's write.
			w.browserJoined = true
			joined = w.active
		}
		w.mu.Unlock()
		w.promoteBackend(joined)
		select {
		case <-ch:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return w.snapshotAfterSpawn()

	case StateStopping:
		w.mu.Unlock()
		return nil, ErrStopping

	case StateBroken:
		if time.Now().Before(w.brokenUntil) {
			err := w.lastSpawnErr
			w.mu.Unlock()
			if err == nil {
				err = ErrBroken
			}
			return nil, err
		}
		// cooled down → fall through to spawn
	}

	// Idle or cooled-down Broken: begin spawn
	w.state = StateStarting
	w.readyCh = make(chan struct{})
	w.lastSpawnErr = nil
	w.browserJoined = false
	readyCh := w.readyCh
	spec := w.Spec()
	socketPath := w.primarySocketPath()
	w.mu.Unlock()

	// Run the spawn outside the lock so concurrent callers see Starting and wait.
	var stats bootStats
	stats.SpawnRequestedAt = time.Now().UnixMilli()
	bk, spawnErr := w.startBackend(spec, socketPath, reason)
	if spawnErr == nil {
		stats.SpawnedAt = time.Now().UnixMilli()
		// Snapshot before any promote clears it (escalation or post-ready).
		// Unpublished yet, so no other goroutine can touch it.
		stats.Demoted = bk.demoted
		// Make cmd visible so Stop can find it before readiness completes.
		w.mu.Lock()
		w.active = bk
		joined := w.browserJoined
		w.mu.Unlock()
		if joined {
			w.promoteBackend(bk)
		}
		stats.Escalated, stats.RespondedHTTP, spawnErr = w.awaitBackendReady(bk, socketPath)
		if spawnErr == nil {
			stats.ReadyObservedAt = time.Now().UnixMilli()
		}
	}

	if spawnErr != nil {
		wrapped := fmt.Errorf("%w: %v", ErrSpawnFailed, spawnErr)
		// Kill if the process started; wait (bounded) for the exit goroutine.
		if bk != nil && bk.cmd != nil && bk.cmd.Process != nil {
			signalBackend(bk, syscall.SIGKILL, w.Name)
			waitBackendExit(bk, w.Name, postKillTimeout)
		}
		if bk != nil {
			_ = removeBackendArtifacts(bk.socketPath)
		}
		w.mu.Lock()
		w.active = nil
		w.state = StateBroken
		w.brokenUntil = time.Now().Add(w.cfg.BrokenCooldown)
		w.lastSpawnErr = wrapped
		w.mu.Unlock()
		close(readyCh)
		slog.Warn("backend spawn failed", "worktree", w.Name, "err", wrapped)
		return nil, wrapped
	}

	// Boot burst over — lift the darwinbg demotion for steady-state serving.
	w.promoteBackend(bk)

	w.mu.Lock()
	w.state = StateRunning
	bk.proxy = newReverseProxy(socketPath)
	w.lastActivity = time.Now()
	w.mu.Unlock()
	go postBootReport(socketPath, stats)
	close(readyCh)
	slog.Info("backend ready", "worktree", w.Name, "socket", socketPath)
	return bk, nil
}

func (w *Worktree) snapshotAfterSpawn() (*backend, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.state == StateRunning && w.active != nil {
		return w.active, nil
	}
	if w.lastSpawnErr != nil {
		return nil, w.lastSpawnErr
	}
	return nil, errors.New("spawn did not complete successfully")
}

const drainTimeout = 30 * time.Second

// postKillTimeout bounds the wait for a backend to exit after SIGKILL. The kill
// can silently fail to land (e.g. EPERM, or a wedged group), and the exit
// goroutine that closes bk.exitCh would then never fire — an unbounded receive
// would hang the calling goroutine forever. Cap it and log loudly instead.
const postKillTimeout = 3 * time.Second

// Restart performs a zero-downtime restart: spawns a new backend on the
// alternate socket, waits for it to be ready, atomically swaps the proxy
// pointer, then drains and stops the old backend in the background.
// If the new backend fails to start, the old backend is left intact.
func (w *Worktree) Restart(ctx context.Context) error {
	w.restartMu.Lock()
	defer w.restartMu.Unlock()

	// --- Step 1: Running → Restarting ---
	w.mu.Lock()
	if w.state != StateRunning {
		s := w.state
		w.mu.Unlock()
		return fmt.Errorf("cannot hot-restart in state %s", s)
	}
	w.state = StateRestarting
	oldBk := w.active
	newSocketPath := w.restartTargetPath()
	spec := w.Spec()
	doneCh := make(chan struct{})
	w.restartDone = doneCh
	w.mu.Unlock()

	defer func() {
		w.mu.Lock()
		w.restartDone = nil
		w.mu.Unlock()
		close(doneCh)
	}()

	// --- Step 2: Spawn new backend on alternate socket ---
	slog.Info("hot restart: spawning", "worktree", w.Name, "socket", newSocketPath)
	var stats bootStats
	stats.SpawnRequestedAt = time.Now().UnixMilli()
	// A restart is a deploy: nobody is waiting on the new process (the old one
	// keeps serving), so it boots in the background.
	newBk, spawnErr := w.startBackend(spec, newSocketPath, StartBackground)

	// --- Step 3: Wait for readiness ---
	if spawnErr == nil {
		stats.SpawnedAt = time.Now().UnixMilli()
		// Snapshot before any promote clears it (escalation or post-ready).
		stats.Demoted = newBk.demoted
		stats.Escalated, stats.RespondedHTTP, spawnErr = w.awaitBackendReady(newBk, newSocketPath)
		if spawnErr == nil {
			stats.ReadyObservedAt = time.Now().UnixMilli()
		}
	}

	// --- Step 4 (failure): keep old backend, revert state ---
	if spawnErr != nil {
		if newBk != nil && newBk.cmd != nil && newBk.cmd.Process != nil {
			signalBackend(newBk, syscall.SIGKILL, w.Name)
			waitBackendExit(newBk, w.Name, postKillTimeout)
		}
		if newBk != nil {
			_ = removeBackendArtifacts(newBk.socketPath)
		}
		w.mu.Lock()
		if w.state == StateRestarting {
			w.state = StateRunning
		}
		w.mu.Unlock()
		return fmt.Errorf("hot restart failed (old backend intact): %w", spawnErr)
	}

	// --- Step 4 (success): atomic swap ---
	// Boot burst over — lift the darwinbg demotion for steady-state serving.
	w.promoteBackend(newBk)
	newBk.proxy = newReverseProxy(newSocketPath)
	w.mu.Lock()
	w.active = newBk
	w.state = StateRunning
	w.lastActivity = time.Now()
	w.mu.Unlock()
	go postBootReport(newSocketPath, stats)
	slog.Info("hot restart: swapped", "worktree", w.Name,
		"old_socket", oldBk.socketPath, "new_socket", newSocketPath)

	// --- Step 5: Drain old backend in background ---
	go w.drainAndStop(oldBk)
	return nil
}

// drainAndStop lets in-flight HTTP requests on bk finish (up to drainTimeout)
// before terminating the process — killing mid-request resets the connection
// and the client sees a 502. WebSocket connections (live-state, terminal, logs)
// are long-lived and never close on their own, so they are NOT waited on; they
// are cut when the process exits and clients reconnect to the already-live new
// backend. Runs in a goroutine kicked off by Restart(); never modifies w.state.
func (w *Worktree) drainAndStop(bk *backend) {
	deadline := time.Now().Add(drainTimeout)
	for bk.httpCount() > 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if n := bk.httpCount(); n > 0 {
		slog.Warn("drain timeout; forcing stop with in-flight HTTP requests",
			"worktree", w.Name, "httpConns", n)
	}
	if n := bk.wsCount(); n > 0 {
		slog.Info("hot restart: cutting WebSocket connections; clients will reconnect",
			"worktree", w.Name, "wsConns", n)
	}
	if bk.cmd != nil && bk.cmd.Process != nil {
		signalBackend(bk, syscall.SIGTERM, w.Name)
		select {
		case <-bk.exitCh:
		case <-time.After(w.cfg.ShutdownGrace):
			signalBackend(bk, syscall.SIGKILL, w.Name)
			waitBackendExit(bk, w.Name, postKillTimeout)
		}
	}
	_ = removeBackendArtifacts(bk.socketPath)
	slog.Info("hot restart: old backend drained and stopped",
		"worktree", w.Name, "socket", bk.socketPath)
}

// Stop performs a graceful shutdown: SIGTERM → grace → SIGKILL. Idempotent.
// If the worktree is currently spawning, Stop waits for the spawn to settle
// first to avoid racing the spawn cleanup path. If a hot restart is in flight,
// waits for it to settle before stopping.
func (w *Worktree) Stop(ctx context.Context) error {
	w.mu.Lock()
	if w.state == StateStarting {
		ch := w.readyCh
		w.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		}
		w.mu.Lock()
	}
	if w.state == StateRestarting {
		doneCh := w.restartDone
		w.mu.Unlock()
		if doneCh != nil {
			select {
			case <-doneCh:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		w.mu.Lock()
	}
	if w.state != StateRunning {
		w.mu.Unlock()
		return nil
	}
	w.state = StateStopping
	bk := w.active
	w.mu.Unlock()

	if bk != nil && bk.cmd != nil && bk.cmd.Process != nil {
		signalBackend(bk, syscall.SIGTERM, w.Name)
		select {
		case <-bk.exitCh:
		case <-time.After(w.cfg.ShutdownGrace):
			signalBackend(bk, syscall.SIGKILL, w.Name)
			waitBackendExit(bk, w.Name, postKillTimeout)
		}
	}

	if bk != nil {
		_ = removeBackendArtifacts(bk.socketPath)
	}
	w.mu.Lock()
	w.active = nil
	w.state = StateIdle
	w.mu.Unlock()

	slog.Info("backend stopped", "worktree", w.Name)
	return nil
}

// TouchBackend resets the idle timer. Called after every backend-bound request.
func (w *Worktree) TouchBackend() {
	w.mu.Lock()
	w.lastActivity = time.Now()
	w.mu.Unlock()
}

// Snapshot returns a consistent view of the worktree state for /gateway/worktrees.
func (w *Worktree) Snapshot() WorktreeStatus {
	w.mu.Lock()
	state := w.state
	last := w.lastActivity
	bk := w.active
	var lastSpawnErr string
	if w.lastSpawnErr != nil {
		lastSpawnErr = w.lastSpawnErr.Error()
	}
	w.mu.Unlock()
	spec := w.Spec()
	var socketPath string
	var conns int
	if bk != nil {
		socketPath = bk.socketPath
		conns = bk.conns()
	}
	return WorktreeStatus{
		Name:         w.Name,
		State:        state.String(),
		SocketPath:   socketPath,
		LastActivity: last,
		ActiveConns:  conns,
		Server:       spec.Server,
		Web:          spec.Web,
		LastSpawnErr: lastSpawnErr,
	}
}

// Pinned reports whether this worktree's backend must live until gateway
// shutdown — never swept for idleness, never stopped on request.
//
// `central` is a singleton runtime that owns heavyweight state (the embedded
// Postgres cluster, secrets keychain, leader-elected notifications). Tearing
// it down forces a PG restart cycle — every per-worktree backend's pool then
// sees the postmaster die and retries land in the WAL-recovery window with
// `57P03 the database system is starting up`. Same magic name as
// `central-routes.json`'s `"backend": "central"`.
func (w *Worktree) Pinned() bool {
	return w.Name == "central"
}

// ShouldSweep reports whether the sweeper should tear this worktree down now.
// The decision lives on Worktree because it touches private state.
func (w *Worktree) ShouldSweep(idleTimeout time.Duration) bool {
	if w.Pinned() {
		return false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	// Sweep when the backend is running and has been idle past the timeout.
	if w.state != StateRunning {
		return false
	}
	if w.active != nil && w.active.conns() > 0 {
		return false
	}
	return time.Since(w.lastActivity) >= idleTimeout
}

// ─── internal helpers ────────────────────────────────────────

// taskpolicyPath is the macOS priority tool used to spawn background boots
// darwinbg (boot burst on efficiency cores) and lift the demotion once ready.
const taskpolicyPath = "/usr/sbin/taskpolicy"

// detectTaskpolicy returns the taskpolicy binary main configures as
// Config.Taskpolicy: taskpolicyPath on macOS when present, else "" (no
// demotion on this host).
func detectTaskpolicy() string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	if _, err := os.Stat(taskpolicyPath); err != nil {
		return ""
	}
	return taskpolicyPath
}

// promoteBackend lifts a darwinbg-demoted backend back to default priority
// (taskpolicy -B -p <pid>) once it is ready — the boot burst is over, and
// steady-state serving (the user browsing the worktree's app) should run on
// all cores. Best-effort: a failed promote just leaves the backend on the
// efficiency cores, which is safe. Idempotent and safe to race: the caller
// that flips bk.demoted (under w.mu) is the one that runs taskpolicy, so the
// post-ready call after an escalation or a browser join is a no-op. A failed
// promote puts the flag back so a later caller retries.
// taskpolicy runs with the declared base environment like every other child,
// so no gateway exec falls back to Go's implicit inherit.
func (w *Worktree) promoteBackend(bk *backend) {
	if bk == nil {
		return
	}
	w.mu.Lock()
	if !bk.demoted || bk.cmd == nil || bk.cmd.Process == nil {
		w.mu.Unlock()
		return
	}
	bk.demoted = false
	pid := bk.cmd.Process.Pid
	w.mu.Unlock()

	out, err := w.cfg.ChildEnv.Command(w.cfg.Taskpolicy, "-B", "-p", fmt.Sprint(pid)).CombinedOutput()
	if err != nil {
		w.mu.Lock()
		bk.demoted = true
		w.mu.Unlock()
		slog.Warn("taskpolicy -B failed; backend stays demoted",
			"worktree", w.Name, "pid", pid, "err", err, "out", strings.TrimSpace(string(out)))
		return
	}
	slog.Info("backend promoted to default priority", "worktree", w.Name, "pid", pid)
}

// demotes reports whether a spawn for reason runs darwinbg: only a background
// start, only where taskpolicy exists, and never main ("singularity") or
// "central" — the interactive / always-on backends.
func (w *Worktree) demotes(reason StartReason) bool {
	return reason == StartBackground && w.cfg.Taskpolicy != "" &&
		w.Name != "singularity" && w.Name != "central"
}

// backendLaunch returns what a backend is told at spawn beyond the declared
// environment: the arguments appended to its argv (after any taskpolicy
// wrapping, so they belong to the backend itself rather than to the wrapper).
//
// Both values travel on ARGV, never in the environment. An env var reaches
// every descendant forever: main's backend was the first process to talk to the
// tmux server after a restart, so every agent session started from it thought
// it was main (the namespace, read by server-core/bin/declare-namespace.ts —
// research/2026-09-15-global-retire-ambient-worktree-env-runtime-identity.md),
// and every process a backend started knew the backend's own socket (read by
// runtime-identity's readServingSocket —
// research/2026-09-15-global-backend-env-leak-followups.md).
func backendLaunch(name, socketPath string) []string {
	return []string{"--namespace", name, "--socket", socketPath}
}

// startBackend builds and starts a backend process on the given socketPath, at
// the priority reason calls for (see demotes). Returns a *backend with cmd and
// exitCh populated; proxy is nil until the caller confirms readiness and calls
// newReverseProxy.
func (w *Worktree) startBackend(spec *Spec, socketPath string, reason StartReason) (*backend, error) {
	// Clear any stale socket + pid sidecar a crashed predecessor left on this path.
	if err := removeBackendArtifacts(socketPath); err != nil {
		return nil, fmt.Errorf("unlink stale socket: %w", err)
	}

	argv := spec.Command
	if len(argv) == 0 {
		argv = []string{"bun", "bin/index.ts"}
	}
	// Boot-time priority isolation: a background start spawns darwinbg
	// (taskpolicy -b execs the target in place, so cmd.Process.Pid stays the
	// backend pid) so its boot burst (catch-up, derived-table rebuild, pool
	// warm) runs on the efficiency cores and cannot starve the interactive
	// main backend. Once ready, w.promoteBackend lifts the demotion (-B -p) so
	// steady-state serving is back on all cores. A browser start skips it: a
	// person is waiting on this boot.
	// See research/2026-07-07-global-background-work-priority-isolation.md.
	demoted := w.demotes(reason)
	if demoted {
		argv = append([]string{w.cfg.Taskpolicy, "-b", "--"}, argv...)
	}
	// The backend's namespace and socket travel on argv (backendLaunch),
	// appended last so they are arguments of the backend, not of the wrapper.
	argv = append(append([]string{}, argv...), backendLaunch(w.Name, socketPath)...)
	cmd := w.cfg.ChildEnv.Command(argv[0], argv[1:]...)
	cmd.Dir = spec.Server
	// The backend's environment is exactly the declared runtime environment
	// (-child-env, captured once at boot — see env.go). Nothing the gateway's
	// starter carried reaches a backend unless it was declared.
	cmd.Env = w.cfg.ChildEnv.With()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	marker := fmt.Sprintf("--- starting %s ---", w.Name)
	fmt.Fprintf(w.logFile, "%s [gateway] %s\n", now.Format(time.RFC3339), marker)
	w.logBuf.Append("gateway", marker, now.UnixMilli())
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	// Record a durable pid sidecar next to the socket so a future gateway
	// generation can reap this backend if we die before stopping it. Best-effort:
	// a missing sidecar degrades to the reconcile's "live, no record" branch.
	if err := writeBackendSidecar(socketPath, w.Name, cmd); err != nil {
		slog.Warn("write pid sidecar failed", "worktree", w.Name, "socket", socketPath, "err", err)
	}

	bk := &backend{
		cmd:        cmd,
		exitCh:     make(chan struct{}),
		startedAt:  now.UnixMilli(),
		socketPath: socketPath,
		demoted:    demoted,
	}
	log := slog.With("worktree", w.Name, "pid", cmd.Process.Pid, "socket", socketPath)
	go pumpLog(stdout, "stdout", w.logBuf, w.logFile)
	go pumpLog(stderr, "stderr", w.logBuf, w.logFile)
	go func() {
		err := cmd.Wait()
		w.onBackendExit(bk, err)
		close(bk.exitCh)
	}()
	log.Info("backend spawned")
	return bk, nil
}

// onBackendExit is invoked from the cmd.Wait goroutine. It only transitions
// state if the exiting backend is the currently active one — a draining old
// backend from a hot restart is silently ignored.
func (w *Worktree) onBackendExit(bk *backend, err error) {
	w.mu.Lock()
	isActive := (w.active == bk)
	state := w.state
	w.mu.Unlock()

	if !isActive {
		return
	}

	if state == StateStopping {
		return
	}

	slog.Warn("backend exited unexpectedly", "worktree", w.Name, "err", err)
	_ = removeBackendArtifacts(bk.socketPath)

	w.mu.Lock()
	defer w.mu.Unlock()
	if w.active != bk {
		return
	}
	w.active = nil
	w.state = StateIdle
}

// logAdaptiveTimeout records the readiness timeout chosen for a spawn so slow
// boots under host load are observable. The load is included when available;
// when it is not (unsupported OS / read error), chosen == base and no load is
// attached.
func logAdaptiveTimeout(worktree string, base, chosen time.Duration) {
	if load, ok := hostLoad1(); ok {
		slog.Info("adaptive readiness timeout", "worktree", worktree,
			"base", base, "chosen", chosen, "load1", load)
		return
	}
	slog.Info("adaptive readiness timeout", "worktree", worktree,
		"base", base, "chosen", chosen)
}

// awaitBackendReady waits for a freshly-spawned backend to pass its readiness
// probe. Slow boots escalate (lift the darwinbg demotion, extend the wait)
// instead of being killed — see waitReady for the wedge-vs-slow reasoning.
// Reports whether the wait escalated, and whether the backend had answered
// HTTP by escalation time, so the caller can include both in the boot report.
func (w *Worktree) awaitBackendReady(bk *backend, socketPath string) (escalated, respondedHTTP bool, err error) {
	base := adaptiveTimeout(w.cfg.ReadyTimeout, w.cfg.ReadyTimeoutMax)
	logAdaptiveTimeout(w.Name, w.cfg.ReadyTimeout, base)
	w.mu.Lock()
	demoted := bk.demoted
	w.mu.Unlock()
	err = waitReady(socketPath, base, w.cfg.ReadyTimeoutMax, demoted, func(responded bool) {
		escalated = true
		respondedHTTP = responded
		slog.Warn("backend slow to become ready; lifting demotion and extending wait instead of killing",
			"worktree", w.Name, "respondedHTTP", responded,
			"base", base, "extension", w.cfg.ReadyTimeoutMax)
		w.promoteBackend(bk)
	}, bk.exitCh)
	if errors.Is(err, errExitedBeforeReady) {
		err = withStderrTail(err, w.logBuf.Tail(exitTailLines, "stderr", bk.startedAt))
	}
	return escalated, respondedHTTP, err
}

// exitTailLines is how much of a backend's own stderr an early exit reports:
// enough for a stack and the error it ends in (a failed boot migration prints
// its pg error, then the rethrow's stack).
const exitTailLines = 40

// errExitedBeforeReady: the backend process ended before its readiness probe
// passed — a boot crash. The error that killed it is on its stderr.
var errExitedBeforeReady = errors.New("backend exited before ready")

// withStderrTail puts the backend's last stderr lines into the error, so the
// restart's 500 body — which `./singularity build` prints — says WHY the boot
// died instead of only that it did. The lines are also in the worktree's
// gateway log; this is the one place the caller is already looking.
func withStderrTail(err error, tail []logEntry) error {
	if len(tail) == 0 {
		return fmt.Errorf("%w (it wrote nothing to stderr)", err)
	}
	lines := make([]string, len(tail))
	for i, e := range tail {
		lines[i] = "  " + e.Line
	}
	return fmt.Errorf("%w; its last stderr lines:\n%s", err, strings.Join(lines, "\n"))
}

// waitReady polls the backend's `GET /api/health/ready` over its Unix socket
// until the backend reports ready, exits, or the deadline expires. This gates
// the hot-swap on genuine readiness (migrations applied, DB warm, registry
// built) rather than a bare socket accept — the old backend keeps serving until
// the new one can actually handle requests.
//
//   - 200 → ready.
//   - 404 → endpoint absent (backend predates this change); fall back to
//     "HTTP-reachable = ready" so older worktrees still start.
//   - 503 / transport error (socket still coming up) → not ready yet; keep polling.
//
// Wedge detection is progress-aware and escalates before it kills. The base
// (load-adaptive) deadline is the wedge threshold, but its expiry alone does
// not prove a wedge:
//   - a backend that has answered HTTP at all (even a 503) is alive and
//     mid-boot, not wedged;
//   - a darwinbg-demoted boot competes only for the E-cores, so under host
//     load it can legitimately need longer than base even to bind its socket
//     (measured 14s+ to first listen during the 2026-07-07 spawn-kill loop —
//     killing it discards near-complete work and re-adds load, which is
//     self-amplifying under sustained contention).
//
// In both cases onEscalate fires once (the caller lifts the demotion so the
// boot finishes at default priority) and the deadline extends by extension.
// Only a silent, never-demoted backend is declared wedged at base. A real
// crash is still caught instantly via exitCh, so the generous extension never
// delays crash detection.
func waitReady(socketPath string, base, extension time.Duration, demoted bool, onEscalate func(respondedHTTP bool), exitCh <-chan struct{}) error {
	client := &http.Client{
		Timeout: 2 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", socketPath)
			},
		},
	}
	deadline := time.Now().Add(base)
	responded, escalated := false, false
	for {
		resp, err := client.Get("http://backend/api/health/ready")
		if err == nil {
			status := resp.StatusCode
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if status == http.StatusOK || status == http.StatusNotFound {
				return nil
			}
			responded = true
		}
		if !time.Now().Before(deadline) {
			if !escalated && (responded || demoted) {
				escalated = true
				deadline = time.Now().Add(extension)
				if onEscalate != nil {
					onEscalate(responded)
				}
			} else if escalated {
				return fmt.Errorf("readiness timeout: still not ready %s after escalation (answered HTTP: %v)", extension, responded)
			} else {
				return fmt.Errorf("readiness timeout after %s (backend never answered HTTP)", base)
			}
		}
		select {
		case <-exitCh:
			return errExitedBeforeReady
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// bootStats is the spawn/readiness timing record the gateway reports to a
// freshly-ready backend. Timestamps are epoch milliseconds; demoted records
// whether the darwinbg wrap was applied at spawn (regardless of later promote).
type bootStats struct {
	SpawnRequestedAt int64 `json:"spawnRequestedAt"`
	SpawnedAt        int64 `json:"spawnedAt"`
	ReadyObservedAt  int64 `json:"readyObservedAt"`
	Escalated        bool  `json:"escalated"`
	RespondedHTTP    bool  `json:"respondedHTTP"`
	Demoted          bool  `json:"demoted"`
}

// postBootReport POSTs a ready backend's spawn/readiness stats to the backend
// itself, fire-and-forget. Runs in its own goroutine strictly after the proxy
// swap: it never touches the worktree state machine and can never delay or
// fail readiness. A 404 means the backend predates the endpoint — tolerated
// version skew, logged at info instead of warn.
func postBootReport(socketPath string, stats bootStats) {
	body, err := json.Marshal(stats)
	if err != nil {
		slog.Warn("boot report: marshal failed", "socket", socketPath, "err", err)
		return
	}
	client := &http.Client{
		Timeout: 2 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", socketPath)
			},
		},
	}
	resp, err := client.Post("http://backend/api/boot/gateway-report", "application/json", bytes.NewReader(body))
	if err != nil {
		slog.Warn("boot report: post failed", "socket", socketPath, "err", err)
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		slog.Info("boot report: endpoint absent (older backend)", "socket", socketPath)
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		slog.Warn("boot report: non-2xx response", "socket", socketPath, "status", resp.StatusCode)
	}
}

// killPgid sends a signal to a whole process group (negative pid), so backends
// that spawn children (like terminal PTYs) clean up too. The backend is the
// group leader (spawned with Setpgid), so pgid == its pid.
func killPgid(pgid int, sig syscall.Signal) error {
	return syscall.Kill(-pgid, sig)
}

// killGroup signals the process group of cmd.
func killGroup(cmd *exec.Cmd, sig syscall.Signal) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	return killPgid(cmd.Process.Pid, sig)
}

// signalBackend sends sig to the backend's process group and logs any error
// other than ESRCH (the process is already gone — a benign no-op). Callers
// proceed to wait on exitCh regardless.
func signalBackend(bk *backend, sig syscall.Signal, worktree string) {
	if err := killGroup(bk.cmd, sig); err != nil && !errors.Is(err, syscall.ESRCH) {
		slog.Warn("signal backend failed",
			"worktree", worktree, "signal", sig.String(), "pid", backendPID(bk), "err", err)
	}
}

// waitBackendExit blocks until the backend's cmd.Wait goroutine closes exitCh,
// bounded by timeout. Without the bound, a kill that never lands would hang the
// caller forever; we cap it and log loudly so the leak is visible.
func waitBackendExit(bk *backend, worktree string, timeout time.Duration) {
	select {
	case <-bk.exitCh:
	case <-time.After(timeout):
		slog.Error("backend did not exit after SIGKILL; possible leak",
			"worktree", worktree, "socket", bk.socketPath, "pid", backendPID(bk))
	}
}

// backendPID returns the backend's pid for logging, or -1 if unknown.
func backendPID(bk *backend) int {
	if bk == nil || bk.cmd == nil || bk.cmd.Process == nil {
		return -1
	}
	return bk.cmd.Process.Pid
}

// processAlive reports whether pid names a live process (signal-0 probe).
// EPERM means it exists but we can't signal it (still "alive"); ESRCH means gone.
func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// reapPgid terminates an orphaned backend's process group: SIGTERM, wait up to
// grace for the leader to vanish, then SIGKILL. ESRCH at any step is success
// (already gone). Used by the boot reconcile, which knows only the sidecar pid.
func reapPgid(pgid, leaderPid int, grace time.Duration, label string) {
	if !processAlive(leaderPid) {
		return
	}
	if err := killPgid(pgid, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		slog.Warn("orphan SIGTERM failed", "label", label, "pgid", pgid, "err", err)
	}
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		if !processAlive(leaderPid) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !processAlive(leaderPid) {
		return
	}
	if err := killPgid(pgid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		slog.Error("orphan SIGKILL failed; possible leak", "label", label, "pgid", pgid, "err", err)
	}
}

// ─── backend pid sidecar ─────────────────────────────────────
//
// A small durable record written next to each socket at spawn so the gateway's
// ownership of a backend survives its own restart. The socket file's presence
// is the trigger for reconcile; the sidecar carries the pid to reap.

type backendSidecar struct {
	PID       int    `json:"pid"`
	PGID      int    `json:"pgid"`
	WallStart string `json:"wallStart"`
	Worktree  string `json:"worktree"`
}

func sidecarPath(socketPath string) string { return socketPath + ".pid" }

// writeBackendSidecar atomically writes the pid record for a freshly-spawned
// backend. pgid == pid because the backend is its own group leader (Setpgid).
func writeBackendSidecar(socketPath, worktree string, cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return errors.New("no process to record")
	}
	pid := cmd.Process.Pid
	data, err := json.Marshal(backendSidecar{
		PID:       pid,
		PGID:      pid,
		WallStart: time.Now().UTC().Format(time.RFC3339),
		Worktree:  worktree,
	})
	if err != nil {
		return err
	}
	tmp := sidecarPath(socketPath) + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, sidecarPath(socketPath))
}

// readBackendSidecar reads and validates the pid record for a socket.
func readBackendSidecar(socketPath string) (*backendSidecar, error) {
	data, err := os.ReadFile(sidecarPath(socketPath))
	if err != nil {
		return nil, err
	}
	var sc backendSidecar
	if err := json.Unmarshal(data, &sc); err != nil {
		return nil, err
	}
	if sc.PID <= 0 || sc.PGID <= 0 {
		return nil, fmt.Errorf("invalid sidecar: pid=%d pgid=%d", sc.PID, sc.PGID)
	}
	return &sc, nil
}

// removeBackendArtifacts removes a backend's socket file then its pid sidecar.
// Socket-first is crash-safe: a leftover sidecar with no socket is reaped by the
// reconcile's dial gate, whereas a leftover socket with no sidecar degrades to
// the recoverable "live, no record" branch. Missing files are not an error;
// only a socket-removal failure (which would block a rebind) is returned.
func removeBackendArtifacts(socketPath string) error {
	sockErr := os.Remove(socketPath)
	if sockErr != nil && errors.Is(sockErr, os.ErrNotExist) {
		sockErr = nil
	}
	if err := os.Remove(sidecarPath(socketPath)); err != nil && !errors.Is(err, os.ErrNotExist) {
		slog.Warn("remove pid sidecar failed", "path", sidecarPath(socketPath), "err", err)
	}
	return sockErr
}

// newReverseProxy builds a reverse proxy that dials the backend's Unix socket.
// The URL Host is a placeholder — the custom Transport ignores Dial address
// args and always dials socketPath. socketPath is captured by value so the
// closure stays bound to the path at construction time.
func newReverseProxy(socketPath string) *httputil.ReverseProxy {
	target := &url.URL{Scheme: "http", Host: "backend"}
	rp := httputil.NewSingleHostReverseProxy(target)
	rp.Transport = &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socketPath)
		},
	}
	origDirector := rp.Director
	rp.Director = func(r *http.Request) {
		origDirector(r)
		r.Host = target.Host
	}
	rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		slog.Warn("reverse proxy error", "err", err)
		http.Error(w, "backend unavailable: "+err.Error(), http.StatusBadGateway)
	}
	return rp
}

// pumpLog forwards one of a backend's output streams to the worktree's own log
// channel: the durable per-worktree file plus the in-memory ring that feeds the
// live UI. Backend output stays out of the gateway's own log — each is its own
// channel.
func pumpLog(r io.ReadCloser, stream string, ring *logRing, file io.Writer) {
	defer r.Close()
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 4096), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		now := time.Now()
		fmt.Fprintf(file, "%s [%s] %s\n", now.Format(time.RFC3339), stream, line)
		if ring != nil {
			ring.Append(stream, line, now.UnixMilli())
		}
	}
}
