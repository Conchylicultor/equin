package main

import (
	"context"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

// startTermIgnoringBackend runs a process group that ignores SIGTERM (a
// backend stuck in its shutdown hooks) as wt's running backend.
func startTermIgnoringBackend(t *testing.T, wt *Worktree) *backend {
	t.Helper()
	// The shell ignores TERM, and so does the sleep it starts (an ignored
	// disposition is inherited across exec).
	cmd := exec.Command("sh", "-c", `trap "" TERM; sleep 60`)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) })
	bk := &backend{cmd: cmd, exitCh: make(chan struct{}), socketPath: wt.primarySocketPath(), proxy: newReverseProxy(wt.primarySocketPath())}
	go func() {
		_ = cmd.Wait()
		close(bk.exitCh)
	}()
	// Let the shell install its trap before anyone signals it.
	time.Sleep(200 * time.Millisecond)
	wt.mu.Lock()
	wt.phase = runningOn(bk)
	wt.mu.Unlock()
	return bk
}

// A stop whose context ends before the SIGTERM grace kills the backend then:
// the grace is a bound inside the caller's budget, not a clock of its own.
func TestStopKillsAtContextDeadlineBeforeGrace(t *testing.T) {
	cfg := &Config{SocketsDir: shortTempDir(t), ShutdownGrace: 30 * time.Second, ChildEnv: testChildEnv(t)}
	wt, err := NewWorktree("t", &Spec{Server: "/tmp/server"}, cfg)
	if err != nil {
		t.Fatalf("NewWorktree: %v", err)
	}
	bk := startTermIgnoringBackend(t, wt)

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	if err := wt.Stop(ctx); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("Stop took %s: the 30 s grace ran instead of the 300 ms context", took)
	}
	select {
	case <-bk.exitCh:
	default:
		t.Fatal("backend still running after Stop returned")
	}
}

// The drain and the backend stops share one budget: a drain that never
// finishes on its own (an open proxied stream) is cut at the budget minus the
// stops' share, and the stops end before the budget — so the whole shutdown
// fits inside it, however the steps would have spent their own clocks.
func TestShutdownWithinSharesOneBudget(t *testing.T) {
	const budget = 1500 * time.Millisecond
	const grace = 400 * time.Millisecond
	var drainEnded, stopEnded time.Time
	var stopDeadline time.Time
	start := time.Now()
	shutdownWithin(budget, grace,
		func(ctx context.Context) error {
			<-ctx.Done() // a stream that never closes
			drainEnded = time.Now()
			return ctx.Err()
		},
		func(ctx context.Context) error {
			stopDeadline, _ = ctx.Deadline()
			<-ctx.Done() // a stop that would take forever
			stopEnded = time.Now()
			return nil
		})
	total := time.Since(start)

	wantDrain := budget - grace - postKillTimeout
	if wantDrain < 0 {
		wantDrain = 0
	}
	if got := drainEnded.Sub(start); got > wantDrain+200*time.Millisecond {
		t.Fatalf("drain ran %s, want at most its share %s", got, wantDrain)
	}
	if got := stopDeadline.Sub(start); got > budget-postKillTimeout+50*time.Millisecond {
		t.Fatalf("stops' deadline at %s, want budget - postKillTimeout (%s)", got, budget-postKillTimeout)
	}
	if stopEnded.IsZero() || total > budget+200*time.Millisecond {
		t.Fatalf("shutdown took %s, over its %s budget", total, budget)
	}
}

// A drain that finishes at once leaves its time to the stops: they run until
// the budget's own deadline, not the drain's.
func TestShutdownWithinFastDrainLeavesTimeToStops(t *testing.T) {
	const budget = 10 * time.Second
	var stopDeadline time.Time
	start := time.Now()
	shutdownWithin(budget, time.Second,
		func(context.Context) error { return nil },
		func(ctx context.Context) error {
			stopDeadline, _ = ctx.Deadline()
			return nil
		})
	if got := stopDeadline.Sub(start); got < budget-postKillTimeout-100*time.Millisecond {
		t.Fatalf("stops' deadline at %s, want about %s", got, budget-postKillTimeout)
	}
}
