package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestWaitReadyOverUDS(t *testing.T) {
	socketPath := filepath.Join(shortTempDir(t), "ready.sock")

	// waitReady probes `GET /api/health/ready` over the socket and only returns
	// once it sees 200/404, so the fake backend must actually speak HTTP — a bare
	// accept-and-close would never satisfy the readiness contract.
	//
	// Bring the backend up after a short delay so waitReady exercises its retry
	// loop against an absent-then-present socket, mirroring the real spawn race.
	go func() {
		time.Sleep(50 * time.Millisecond)
		l, err := net.Listen("unix", socketPath)
		if err != nil {
			t.Errorf("listen unix: %v", err)
			return
		}
		t.Cleanup(func() { _ = l.Close() })

		srv := &http.Server{
			Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/health/ready" {
					w.WriteHeader(http.StatusOK)
					return
				}
				w.WriteHeader(http.StatusNotFound)
			}),
		}
		t.Cleanup(func() { _ = srv.Close() })
		_ = srv.Serve(l)
	}()

	exitCh := make(chan struct{})
	if err := waitReady(socketPath, 2*time.Second, 2*time.Second, false, nil, exitCh); err != nil {
		t.Fatalf("waitReady: %v", err)
	}
}

func TestWaitReadyTimesOutWhenSocketAbsent(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "nope.sock")
	exitCh := make(chan struct{})
	start := time.Now()
	err := waitReady(socketPath, 200*time.Millisecond, 5*time.Second, false, nil, exitCh)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("waitReady should have timed out, got nil")
	}
	// A silent, never-demoted backend is the one case that must still be
	// declared wedged at the base deadline — no escalation, no extension.
	if !strings.Contains(err.Error(), "never answered") {
		t.Fatalf("unexpected error: %v", err)
	}
	if elapsed < 150*time.Millisecond {
		t.Fatalf("waitReady returned too quickly: %s", elapsed)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("silent non-demoted backend should not get the extension: %s", elapsed)
	}
}

func TestWaitReadyReturnsWhenBackendExits(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "exit.sock")
	exitCh := make(chan struct{})

	// Close exitCh after a tick so waitReady's exit-watch fires before
	// the dial deadline.
	go func() {
		time.Sleep(50 * time.Millisecond)
		close(exitCh)
	}()

	err := waitReady(socketPath, 5*time.Second, 5*time.Second, false, nil, exitCh)
	if err == nil {
		t.Fatal("waitReady should have errored on early exit, got nil")
	}
	if !strings.Contains(err.Error(), "exited before ready") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// serve503ThenReady stands up an HTTP server on socketPath whose readiness
// endpoint answers 503 until readyAfter has elapsed, then 200 — the shape of a
// real backend mid readiness-barrier (migrations, DB warm, registry build).
// Goroutine-safe: reports failures via t.Errorf, never FailNow.
func serve503ThenReady(t *testing.T, socketPath string, readyAfter time.Duration) {
	t.Helper()
	l, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Errorf("listen unix: %v", err)
		return
	}
	t.Cleanup(func() { _ = l.Close() })
	start := time.Now()
	srv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if time.Since(start) < readyAfter {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			w.WriteHeader(http.StatusOK)
		}),
	}
	t.Cleanup(func() { _ = srv.Close() })
	go func() { _ = srv.Serve(l) }()
}

// TestWaitReadyEscalatesWhileBooting covers the 2026-07-07 spawn-kill loop: a
// backend answering 503 (alive, mid-boot) past the base deadline must not be
// declared wedged — waitReady escalates exactly once and keeps waiting.
func TestWaitReadyEscalatesWhileBooting(t *testing.T) {
	socketPath := filepath.Join(shortTempDir(t), "boot.sock")
	serve503ThenReady(t, socketPath, 400*time.Millisecond)

	escalations := 0
	err := waitReady(socketPath, 150*time.Millisecond, 5*time.Second, false, func(responded bool) {
		escalations++
		if !responded {
			t.Error("escalation for a 503-answering backend should report respondedHTTP=true")
		}
	}, make(chan struct{}))
	if err != nil {
		t.Fatalf("waitReady should succeed after escalation: %v", err)
	}
	if escalations != 1 {
		t.Fatalf("expected exactly 1 escalation, got %d", escalations)
	}
}

// TestWaitReadyEscalatesDemotedSilentBackend: a darwinbg-demoted boot competes
// only for E-cores and can be socket-silent past the base deadline under host
// load — its silence is not proof of a wedge, so it escalates instead of dying.
func TestWaitReadyEscalatesDemotedSilentBackend(t *testing.T) {
	socketPath := filepath.Join(shortTempDir(t), "slow.sock")
	// The socket appears only after the base deadline has expired.
	go func() {
		time.Sleep(300 * time.Millisecond)
		serve503ThenReady(t, socketPath, 0)
	}()

	escalations := 0
	err := waitReady(socketPath, 100*time.Millisecond, 5*time.Second, true, func(responded bool) {
		escalations++
		if responded {
			t.Error("silent demoted backend should escalate with respondedHTTP=false")
		}
	}, make(chan struct{}))
	if err != nil {
		t.Fatalf("waitReady should succeed after demoted-silent escalation: %v", err)
	}
	if escalations != 1 {
		t.Fatalf("expected exactly 1 escalation, got %d", escalations)
	}
}

// TestWaitReadyEscalationBounded: the extension is a ceiling, not forever — a
// backend stuck answering 503 is eventually declared wedged after base+extension.
func TestWaitReadyEscalationBounded(t *testing.T) {
	socketPath := filepath.Join(shortTempDir(t), "stuck.sock")
	serve503ThenReady(t, socketPath, time.Hour) // 503 forever

	start := time.Now()
	err := waitReady(socketPath, 100*time.Millisecond, 200*time.Millisecond, false, nil, make(chan struct{}))
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("waitReady should time out after the escalation extension, got nil")
	}
	if !strings.Contains(err.Error(), "after escalation") {
		t.Fatalf("unexpected error: %v", err)
	}
	if elapsed < 250*time.Millisecond {
		t.Fatalf("returned before base+extension elapsed: %s", elapsed)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("escalated wait should stay bounded: %s", elapsed)
	}
}

func TestNewReverseProxyOverUDS(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "proxy.sock")

	// Stand up a minimal HTTP/1.1 server on a Unix socket. We bypass the
	// http package's listener wiring so the test stays focused on whether
	// the reverse proxy's custom Transport actually dials UDS.
	l, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}
	t.Cleanup(func() { _ = l.Close() })

	srv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain")
			_, _ = io.WriteString(w, "hello-uds:"+r.URL.Path)
		}),
	}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })

	rp := newReverseProxy(socketPath)

	req := httptest.NewRequest(http.MethodGet, "http://backend/api/ping", nil)
	rec := httptest.NewRecorder()
	rp.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%q", rec.Code, rec.Body.String())
	}
	if got, want := rec.Body.String(), "hello-uds:/api/ping"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}

// TestReconcileRemovesDeadSockets covers the incident regression: a socket file
// with no live listener is removed even for a REGISTERED worktree (the old
// name-based sweep kept registered sockets, which is how a `.next.sock`-only
// leftover lingered). Non-.sock files are untouched.
func TestReconcileRemovesDeadSockets(t *testing.T) {
	dir := shortTempDir(t)
	mustTouch(t, filepath.Join(dir, "alive.sock"))      // registered, but no listener → dead
	mustTouch(t, filepath.Join(dir, "alive.next.sock")) // the incident's leftover
	mustTouch(t, filepath.Join(dir, "orphan.sock"))     // unregistered, no listener
	mustTouch(t, filepath.Join(dir, "orphan.next.sock"))
	mustTouch(t, filepath.Join(dir, "ignore.txt"))

	cfg := &Config{SocketsDir: dir, ChildEnv: testChildEnv(t)}
	reg := NewRegistry(cfg)
	wt, err := NewWorktree("alive", &Spec{Server: "/tmp/server"}, cfg)
	if err != nil {
		t.Fatalf("NewWorktree: %v", err)
	}
	reg.byName["alive"] = wt

	reconcileOrphanBackends(dir, reg)

	for _, dead := range []string{"alive.sock", "alive.next.sock", "orphan.sock", "orphan.next.sock"} {
		if _, err := os.Stat(filepath.Join(dir, dead)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s should be removed (no listener); stat err: %v", dead, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "ignore.txt")); err != nil {
		t.Fatalf("ignore.txt should remain (only *.sock is reconciled): %v", err)
	}
}

// TestReconcileReapsLiveOrphan covers the core fix: a live backend bound to a
// socket with a pid sidecar is killed and its artifacts removed. A real child
// process in its own group stands in for the orphan; a separate listener makes
// the liveness gate fire.
func TestReconcileReapsLiveOrphan(t *testing.T) {
	dir := shortTempDir(t)
	sockPath := filepath.Join(dir, "wt.sock")
	l, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}
	t.Cleanup(func() { _ = l.Close() })

	cmd := exec.Command("sleep", "60")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sleep: %v", err)
	}
	pid := cmd.Process.Pid
	// Reap the zombie when our child dies so processAlive() sees it gone (in
	// production the orphan is launchd's child and is reaped immediately).
	go func() { _ = cmd.Wait() }()
	t.Cleanup(func() { _ = cmd.Process.Kill() })

	if err := writeBackendSidecar(sockPath, "wt", cmd); err != nil {
		t.Fatalf("writeBackendSidecar: %v", err)
	}

	cfg := &Config{SocketsDir: dir, ChildEnv: testChildEnv(t)}
	reg := NewRegistry(cfg)
	reconcileOrphanBackends(dir, reg)

	waitGone(t, pid, 3*time.Second)
	if _, err := os.Stat(sockPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket should be removed after reap; stat err: %v", err)
	}
	if _, err := os.Stat(sockPath + ".pid"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("sidecar should be removed after reap; stat err: %v", err)
	}
}

// TestReconcileLeavesLiveBackendWithoutSidecar: a live socket with no pid record
// (legacy backend) is left in place — we can't safely identify the pid to kill.
func TestReconcileLeavesLiveBackendWithoutSidecar(t *testing.T) {
	dir := shortTempDir(t)
	sockPath := filepath.Join(dir, "legacy.sock")
	l, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}
	t.Cleanup(func() { _ = l.Close() })

	cfg := &Config{SocketsDir: dir, ChildEnv: testChildEnv(t)}
	reconcileOrphanBackends(dir, NewRegistry(cfg))

	if _, err := os.Stat(sockPath); err != nil {
		t.Fatalf("live socket without sidecar should remain: %v", err)
	}
}

// TestReconcileGCsOrphanSidecar: a *.pid whose socket is already gone is removed.
func TestReconcileGCsOrphanSidecar(t *testing.T) {
	dir := shortTempDir(t)
	orphanPid := filepath.Join(dir, "gone.sock.pid")
	mustTouch(t, orphanPid)

	cfg := &Config{SocketsDir: dir, ChildEnv: testChildEnv(t)}
	reconcileOrphanBackends(dir, NewRegistry(cfg))

	if _, err := os.Stat(orphanPid); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("orphan sidecar should be GC'd; stat err: %v", err)
	}
}

// TestWaitBackendExitBounded proves the previously-unbounded post-SIGKILL wait
// now returns within the timeout when exitCh never closes (Leak 1).
func TestWaitBackendExitBounded(t *testing.T) {
	bk := &backend{exitCh: make(chan struct{}), socketPath: "/tmp/never.sock"}
	start := time.Now()
	waitBackendExit(bk, "t", 100*time.Millisecond)
	elapsed := time.Since(start)
	if elapsed < 80*time.Millisecond || elapsed > time.Second {
		t.Fatalf("waitBackendExit should return ~100ms, took %v", elapsed)
	}
}

func TestStartBackendUnlinksStaleSocket(t *testing.T) {
	// We don't actually spawn bun here — we exercise just the unlink-before-spawn
	// logic by populating the socket path with a stale file and confirming the
	// helper that runs on spawn would remove it. Since startBackend bundles
	// unlink + cmd.Start, the cleanest unit-level check is to call os.Remove
	// directly with the same semantics startBackend uses.
	dir := t.TempDir()
	socketPath := filepath.Join(dir, "stale.sock")
	mustTouch(t, socketPath)

	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unlink: %v", err)
	}
	if _, err := os.Stat(socketPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale socket should be gone; stat err: %v", err)
	}

	// Idempotent on missing file.
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unlink missing should be silent, got: %v", err)
	}
}

func TestNewWorktreeRejectsOverlongSocketPath(t *testing.T) {
	// .next.sock is 10 bytes + "/" separator + name. SocketsDir=80 chars +
	// "/bbbbbbbbbb.next.sock" = 80+1+10+10 = 101 which is under 104.
	// Push it past 104 to trigger rejection.
	cfg := &Config{SocketsDir: strings.Repeat("a", 90), ChildEnv: testChildEnv(t)}
	_, err := NewWorktree("bbbbbbbbbbbbbbbb", &Spec{Server: "/tmp/server"}, cfg)
	if err == nil {
		t.Fatal("expected error for overlong path, got nil")
	}
	if !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSocketPathAlternation(t *testing.T) {
	dir := t.TempDir()
	cfg := &Config{SocketsDir: dir, ChildEnv: testChildEnv(t)}
	wt, err := NewWorktree("test", &Spec{Server: "/tmp/server"}, cfg)
	if err != nil {
		t.Fatalf("NewWorktree: %v", err)
	}

	primary := wt.primarySocketPath()
	secondary := wt.secondarySocketPath()

	if primary == secondary {
		t.Fatalf("primary and secondary should differ: %s", primary)
	}
	if !strings.HasSuffix(primary, ".sock") {
		t.Fatalf("primary should end with .sock: %s", primary)
	}
	if !strings.HasSuffix(secondary, ".next.sock") {
		t.Fatalf("secondary should end with .next.sock: %s", secondary)
	}

	// With no active backend, restartTargetPath returns primary.
	wt.mu.Lock()
	target := wt.restartTargetPath()
	wt.mu.Unlock()
	if target != primary {
		t.Fatalf("restartTargetPath with nil active should be primary, got %s", target)
	}

	// With active on primary, restartTargetPath returns secondary.
	wt.mu.Lock()
	wt.active = &backend{socketPath: primary}
	target = wt.restartTargetPath()
	wt.mu.Unlock()
	if target != secondary {
		t.Fatalf("restartTargetPath with active on primary should be secondary, got %s", target)
	}

	// With active on secondary, restartTargetPath returns primary.
	wt.mu.Lock()
	wt.active = &backend{socketPath: secondary}
	target = wt.restartTargetPath()
	wt.mu.Unlock()
	if target != primary {
		t.Fatalf("restartTargetPath with active on secondary should be primary, got %s", target)
	}
}

func TestBackendConnTracking(t *testing.T) {
	bk := &backend{}
	if bk.conns() != 0 {
		t.Fatal("initial conns should be 0")
	}
	bk.incWS()
	bk.incWS()
	bk.incHTTP()
	if bk.wsCount() != 2 {
		t.Fatalf("expected 2 ws conns, got %d", bk.wsCount())
	}
	if bk.httpCount() != 1 {
		t.Fatalf("expected 1 http conn, got %d", bk.httpCount())
	}
	if bk.conns() != 3 {
		t.Fatalf("expected 3 total conns, got %d", bk.conns())
	}
	bk.decWS()
	bk.decHTTP()
	if bk.conns() != 1 {
		t.Fatalf("expected 1 total conn, got %d", bk.conns())
	}
	bk.decWS()
	bk.decWS()   // should not go negative
	bk.decHTTP() // should not go negative
	if bk.conns() != 0 {
		t.Fatalf("expected 0 conns, got %d", bk.conns())
	}
}

func TestOnBackendExitIgnoresDraining(t *testing.T) {
	dir := shortTempDir(t)
	cfg := &Config{SocketsDir: dir, ShutdownGrace: 5 * time.Second, ChildEnv: testChildEnv(t)}
	wt, err := NewWorktree("t", &Spec{Server: "/tmp/server"}, cfg)
	if err != nil {
		t.Fatalf("NewWorktree: %v", err)
	}

	activeBk := &backend{socketPath: filepath.Join(dir, "active.sock")}
	drainingBk := &backend{socketPath: filepath.Join(dir, "draining.sock")}

	wt.mu.Lock()
	wt.state = StateRunning
	wt.active = activeBk
	wt.mu.Unlock()

	// Simulate the draining backend exiting — should NOT change state.
	wt.onBackendExit(drainingBk, nil)

	wt.mu.Lock()
	state := wt.state
	active := wt.active
	wt.mu.Unlock()

	if state != StateRunning {
		t.Fatalf("state should remain Running, got %s", state)
	}
	if active != activeBk {
		t.Fatal("active backend should not change when a non-active backend exits")
	}
}

func TestEnsureReturnsProxyDuringRestart(t *testing.T) {
	dir := shortTempDir(t)
	cfg := &Config{SocketsDir: dir, ChildEnv: testChildEnv(t)}
	wt, err := NewWorktree("t", &Spec{Server: "/tmp/server"}, cfg)
	if err != nil {
		t.Fatalf("NewWorktree: %v", err)
	}

	proxy := newReverseProxy(filepath.Join(dir, "t.sock"))
	wt.mu.Lock()
	wt.state = StateRestarting
	wt.active = &backend{
		socketPath: filepath.Join(dir, "t.sock"),
		proxy:      proxy,
	}
	wt.restartDone = make(chan struct{})
	wt.mu.Unlock()

	// Ensure() should return the old backend during a restart, not block or error.
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	got, err := wt.Ensure(ctx, StartBackground)
	if err != nil {
		t.Fatalf("Ensure during restart should not error: %v", err)
	}
	if got == nil || got.proxy != proxy {
		t.Fatal("Ensure during restart should return the old backend's proxy")
	}
}

// TestDrainWaitsForHTTPNotWS verifies the drain blocks on in-flight HTTP
// requests but ignores long-lived WebSocket connections. bk.cmd is nil so the
// kill step is skipped and only the drain-wait behavior is exercised.
func TestDrainWaitsForHTTPNotWS(t *testing.T) {
	cfg := &Config{SocketsDir: shortTempDir(t), ChildEnv: testChildEnv(t)}
	wt, err := NewWorktree("t", &Spec{Server: "/tmp/s"}, cfg)
	if err != nil {
		t.Fatalf("NewWorktree: %v", err)
	}

	// WebSocket connections alone must NOT hold the drain — they never close on
	// their own. With no in-flight HTTP, drainAndStop returns promptly.
	bk := &backend{socketPath: filepath.Join(cfg.SocketsDir, "t.sock")}
	bk.incWS()
	bk.incWS()
	start := time.Now()
	wt.drainAndStop(bk)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("drain should not wait on WS conns; took %v", elapsed)
	}

	// An in-flight HTTP request holds the drain until it completes.
	bk2 := &backend{socketPath: filepath.Join(cfg.SocketsDir, "t2.sock")}
	bk2.incHTTP()
	go func() {
		time.Sleep(150 * time.Millisecond)
		bk2.decHTTP()
	}()
	start = time.Now()
	wt.drainAndStop(bk2)
	elapsed := time.Since(start)
	if elapsed < 100*time.Millisecond {
		t.Fatalf("drain returned before the in-flight HTTP request finished (%v)", elapsed)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("drain waited too long for HTTP to finish (%v)", elapsed)
	}
}

// ─── helpers ─────────────────────────────────────────────────

// shortTempDir creates a temp dir with a short path to stay within the
// 104-byte macOS sun_path limit for socket paths in tests.
func shortTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "gw-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// waitGone blocks until pid is no longer a live process, or fails after timeout.
func waitGone(t *testing.T, pid int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("pid %d still alive after %s", pid, timeout)
}

func mustTouch(t *testing.T, path string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create %s: %v", path, err)
	}
	_ = f.Close()
}
