package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// setGate points the worktree's next spawn at its own gate file: the helper
// backend answers 503 until that file exists, so each spawn's readiness is
// released by the test, one at a time.
func (pf priorityFixture) setGate(t *testing.T, gate string) {
	t.Helper()
	spec := *pf.wt.Spec()
	spec.Command = []string{pf.wt.Spec().Command[0], "-test.run=^TestHelperBackend$", "--", "spawns=" + pf.spawns, "gate=" + gate}
	pf.wt.UpdateSpec(&spec)
}

func killBackend(t *testing.T, bk *backend) {
	t.Helper()
	if err := syscall.Kill(-bk.cmd.Process.Pid, syscall.SIGKILL); err != nil {
		t.Fatalf("kill backend: %v", err)
	}
	select {
	case <-bk.exitCh: // closed after onBackendExit ran
	case <-time.After(5 * time.Second):
		t.Fatal("killed backend never exited")
	}
}

// The 2026-11-08 18:21 incident, step by step: main's backend dies while a hot
// restart is booting its successor, a request asks for main meanwhile, and
// then the successor dies too. Before the phase union, the request
// cold-spawned a third backend on the primary socket beside the restart; the
// swap overwrote it as active, the successor's exit cleared active to nil, the
// cold spawn's readiness then set state=running anyway — and the drain of the
// already-dead old backend unlinked the cold spawn's fresh socket (same path).
// Ensure then answered (nil, nil) forever; handleHTTP dereferenced it.
func TestBackendExitDuringHotRestartNeverLeavesRunningWithoutBackend(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	pf.wt.cfg.ReadyTimeout = 20 * time.Second
	pf.wt.cfg.ReadyTimeoutMax = 20 * time.Second
	dir := t.TempDir()
	ctx := context.Background()

	old, err := pf.wt.Ensure(ctx, StartBrowser, "test")
	if err != nil || old == nil {
		t.Fatalf("first start: %v, %v", old, err)
	}

	// A deploy hot-restarts it; the successor boots, gated.
	g2 := filepath.Join(dir, "g2")
	pf.setGate(t, g2)
	restartErr := make(chan error, 1)
	go func() { restartErr <- pf.wt.Restart(ctx) }()
	waitFor(t, "the successor to spawn", func() bool { return pf.spawnCount() == 2 })

	// The serving backend crashes mid-restart: its waiters now wait on the
	// successor's boot.
	killBackend(t, old)
	if s := pf.state(); s != "starting" {
		t.Fatalf("after the serving backend exited mid-restart: state %s, want starting (on the successor)", s)
	}

	// A request asks for the worktree while the successor is still booting:
	// it joins that boot rather than spawning a rival on the primary socket.
	type ensured struct {
		bk  *backend
		err error
	}
	asked := make(chan ensured, 1)
	go func() {
		bk, err := pf.wt.Ensure(ctx, StartBrowser, "test")
		asked <- ensured{bk, err}
	}()

	// The successor becomes ready: the restart ends the phase it owns, and
	// the waiting request gets the successor.
	mustTouch(t, g2)
	if err := <-restartErr; err != nil {
		t.Fatalf("restart: %v", err)
	}
	got := <-asked
	if got.err != nil || got.bk == nil {
		t.Fatalf("the waiting request: %v, %v", got.bk, got.err)
	}
	successor, err := pf.wt.Ensure(ctx, StartBackground, "test")
	if err != nil || successor != got.bk {
		t.Fatalf("after the restart: %v, %v; want the successor the request got", successor, err)
	}
	if n := pf.spawnCount(); n != 2 {
		t.Fatalf("spawns = %d, want 2: the request must not cold-spawn beside the restart", n)
	}

	// The successor dies (it carried the same crash): idle, and the next
	// request cold-starts a fresh backend that is really served.
	killBackend(t, successor)
	if s := pf.state(); s != "idle" {
		t.Fatalf("after the successor exited: state %s, want idle", s)
	}
	g3 := filepath.Join(dir, "g3")
	pf.setGate(t, g3)
	mustTouch(t, g3)
	bk, err := pf.wt.Ensure(ctx, StartBackground, "test")
	if err != nil || bk == nil || bk == successor || bk.proxy == nil {
		t.Fatalf("cold start after both exits: %v, %v", bk, err)
	}
	if _, err := os.Stat(bk.socketPath); err != nil {
		t.Fatalf("the serving backend's socket: %v", err)
	}
}

// A predecessor's late cleanup never removes its successor's socket: both
// sockets are reused, so cleanup goes by the sidecar's pid, not the path.
func TestReleaseBackendArtifactsLeavesASuccessorsSocket(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	ctx := context.Background()
	first, err := pf.wt.Ensure(ctx, StartBrowser, "test")
	if err != nil {
		t.Fatal(err)
	}
	killBackend(t, first)
	second, err := pf.wt.Ensure(ctx, StartBrowser, "test")
	if err != nil {
		t.Fatal(err)
	}
	if second.socketPath != first.socketPath {
		t.Fatalf("expected the cold start to reuse %s, got %s", first.socketPath, second.socketPath)
	}
	// The predecessor's cleanup runs late (a drain, say).
	pf.wt.releaseBackendArtifacts(first)
	if _, err := os.Stat(second.socketPath); err != nil {
		t.Fatalf("the successor's socket was removed: %v", err)
	}
	if _, err := os.Stat(sidecarPath(second.socketPath)); err != nil {
		t.Fatalf("the successor's sidecar was removed: %v", err)
	}
}

// A hot restart whose successor fails after the serving backend exited
// leaves the worktree broken with the failure — not running, not hung.
func TestHotRestartFailingAfterServingExitIsBroken(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	ctx := context.Background()
	old, err := pf.wt.Ensure(ctx, StartBrowser, "test")
	if err != nil {
		t.Fatal(err)
	}
	gate := filepath.Join(t.TempDir(), "gate")
	pf.setGate(t, gate)
	restartErr := make(chan error, 1)
	go func() { restartErr <- pf.wt.Restart(ctx) }()
	waitFor(t, "the successor to spawn", func() bool { return pf.spawnCount() == 2 })
	killBackend(t, old)

	asked := make(chan error, 1)
	go func() {
		_, err := pf.wt.Ensure(ctx, StartBrowser, "test")
		asked <- err
	}()
	var successor *backend
	waitFor(t, "the successor to be published", func() bool {
		pf.wt.mu.Lock()
		defer pf.wt.mu.Unlock()
		successor = backendOf(pf.wt.phase)
		return successor != nil
	})
	killBackend(t, successor)

	if err := <-restartErr; !errors.Is(err, ErrSpawnFailed) {
		t.Fatalf("restart: %v, want a spawn failure", err)
	}
	if err := <-asked; !errors.Is(err, ErrSpawnFailed) {
		t.Fatalf("the waiting request: %v, want the restart's spawn failure", err)
	}
	if s := pf.state(); s != "broken" {
		t.Fatalf("state %s, want broken", s)
	}
}

// A backend that passes readiness and exits before its owner publishes it is
// a failed boot — never a running phase naming a dead backend (which would
// answer every request with a dial to a missing socket).
func TestBackendExitingRightAfterReadyIsNotPublished(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	ctx := context.Background()
	testHookBootReady = func(bk *backend) { killBackend(t, bk) }
	t.Cleanup(func() { testHookBootReady = nil })

	// A cold start.
	if _, err := pf.wt.Ensure(ctx, StartBrowser, "test"); !errors.Is(err, errExitedAfterReady) {
		t.Fatalf("cold start: %v, want errExitedAfterReady", err)
	}
	if s := pf.state(); s != "broken" {
		t.Fatalf("after the cold start: state %s, want broken", s)
	}

	// A hot restart: the old backend stays.
	testHookBootReady = nil
	old, err := pf.wt.Ensure(ctx, StartDeploy, "test")
	if err != nil {
		t.Fatal(err)
	}
	testHookBootReady = func(bk *backend) { killBackend(t, bk) }
	if err := pf.wt.Restart(ctx); !errors.Is(err, errExitedAfterReady) {
		t.Fatalf("restart: %v, want errExitedAfterReady", err)
	}
	if bk, err := pf.wt.Ensure(ctx, StartBackground, "test"); err != nil || bk != old {
		t.Fatalf("after the restart: %v, %v; want the old backend still serving", bk, err)
	}
}

// A deploy arriving while a boot is in flight waits it out, then deploys onto
// the fresh spec (a hot restart here) — not a 503, and not the in-flight
// boot's backend, which was spawned from the spec before the deploy.
func TestDeployDuringABootWaitsThenRestarts(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", true)
	ctx := context.Background()
	go func() { _, _ = pf.wt.Ensure(ctx, StartBrowser, "test") }()
	waitFor(t, "the boot to spawn", func() bool { return pf.spawnCount() == 1 })

	type deployed struct {
		status int
		err    error
	}
	done := make(chan deployed, 1)
	go func() {
		status, err := deployRestart(ctx, pf.wt, "test")
		done <- deployed{status, err}
	}()
	pf.openGate(t)
	got := <-done
	if got.err != nil {
		t.Fatalf("deploy: %d %v", got.status, got.err)
	}
	if n := pf.spawnCount(); n != 2 {
		t.Fatalf("spawns = %d, want 2: the boot, then the deploy's restart", n)
	}
}
