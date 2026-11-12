package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func postStop(p *Proxy, name string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "http://localhost:9000/gateway/worktrees/"+name+"/stop", nil)
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)
	return rec
}

// runFakeBackend installs a live `sleep` process (own process group, like a
// spawned backend) as wt's running backend, with its socket file on disk.
func runFakeBackend(t *testing.T, wt *Worktree) (*backend, int) {
	t.Helper()
	cmd := exec.Command("sleep", "60")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sleep: %v", err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	bk := &backend{cmd: cmd, exitCh: make(chan struct{}), socketPath: wt.primarySocketPath(), proxy: newReverseProxy(wt.primarySocketPath())}
	go func() {
		_ = cmd.Wait()
		close(bk.exitCh)
	}()
	mustTouch(t, bk.socketPath)

	wt.mu.Lock()
	wt.phase = runningOn(bk)
	wt.mu.Unlock()
	return bk, cmd.Process.Pid
}

func decodeStatus(t *testing.T, rec *httptest.ResponseRecorder) WorktreeStatus {
	t.Helper()
	var st WorktreeStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatalf("decode status %q: %v", rec.Body.String(), err)
	}
	return st
}

// A running backend is torn down the way the sweeper does it: the process has
// exited and its socket is gone by the time the response arrives, and the
// worktree stays registered at idle so the next request cold-starts it.
func TestStopRouteStopsRunningBackend(t *testing.T) {
	fx := newStaticProxy(t)
	wt := fx.reg.Resolve("alpha")
	if wt == nil {
		t.Fatal("alpha should resolve")
	}
	bk, pid := runFakeBackend(t, wt)

	rec := postStop(fx.proxy, "alpha")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", rec.Code, rec.Body.String())
	}
	st := decodeStatus(t, rec)
	if st.Name != "alpha" || st.State != "idle" || st.SocketPath != "" {
		t.Fatalf("status = %+v, want alpha idle with no socket", st)
	}
	select {
	case <-bk.exitCh:
	default:
		t.Fatal("backend must have exited before the response")
	}
	waitGone(t, pid, time.Second)
	if _, err := os.Stat(bk.socketPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket should be removed; stat err: %v", err)
	}
	if fx.reg.Get("alpha") != wt {
		t.Fatal("worktree must stay registered after stop")
	}
}

// Stopping an idle worktree is a no-op that still reports its status.
func TestStopRouteIdleIsNoop(t *testing.T) {
	fx := newStaticProxy(t)
	rec := postStop(fx.proxy, "alpha")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", rec.Code, rec.Body.String())
	}
	if st := decodeStatus(t, rec); st.State != "idle" {
		t.Fatalf("state = %q, want idle", st.State)
	}
}

// central is pinned exactly as the sweeper pins it: refused, backend untouched.
func TestStopRouteRefusesCentral(t *testing.T) {
	fx := newStaticProxyNamed(t, "central")
	wt := fx.reg.Resolve("central")
	if wt == nil {
		t.Fatal("central should resolve")
	}
	bk, _ := runFakeBackend(t, wt)

	rec := postStop(fx.proxy, "central")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body %q", rec.Code, rec.Body.String())
	}
	if st := wt.Snapshot(); st.State != "running" {
		t.Fatalf("central state = %q, want running", st.State)
	}
	select {
	case <-bk.exitCh:
		t.Fatal("central's backend must not be stopped")
	default:
	}
	if _, err := os.Stat(filepath.Clean(bk.socketPath)); err != nil {
		t.Fatalf("central's socket must stay: %v", err)
	}
}

func TestStopRouteUnknownWorktree404(t *testing.T) {
	fx := newStaticProxy(t)
	if rec := postStop(fx.proxy, "nope"); rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func postStopHeld(p *Proxy, name string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "http://localhost:9000/gateway/worktrees/"+name+"/stop?hold=1", nil)
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)
	return rec
}

// A held stop leaves the worktree idle with no backend, and traffic — a
// browser or a background caller — cannot cold-start one onto data its caller
// is about to replace. Only a deploy start leaves the hold.
func TestStopRouteHoldKeepsTrafficFromStarting(t *testing.T) {
	fx := newStaticProxy(t)
	wt := fx.reg.Resolve("alpha")
	if wt == nil {
		t.Fatal("alpha should resolve")
	}
	bk, pid := runFakeBackend(t, wt)

	rec := postStopHeld(fx.proxy, "alpha")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", rec.Code, rec.Body.String())
	}
	st := decodeStatus(t, rec)
	if st.State != "idle" || !st.Held {
		t.Fatalf("status = %+v, want idle and held", st)
	}
	select {
	case <-bk.exitCh:
	default:
		t.Fatal("backend must have exited before the response")
	}
	waitGone(t, pid, time.Second)

	for _, reason := range []StartReason{StartBrowser, StartBackground} {
		if _, err := wt.Ensure(context.Background(), reason, "test"); !errors.Is(err, ErrHeld) {
			t.Fatalf("Ensure(%v) err = %v, want ErrHeld", reason, err)
		}
	}
	if st := wt.Snapshot(); st.State != "idle" || !st.Held {
		t.Fatalf("after refused traffic: %+v, want still idle and held", st)
	}

	// A deploy start is the release: it begins a boot (whatever that boot's
	// outcome in this fixture), and the hold is gone with it.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := wt.Ensure(ctx, StartDeploy, "test"); errors.Is(err, ErrHeld) {
		t.Fatalf("a deploy start must leave the hold, got %v", err)
	}
	if st := wt.Snapshot(); st.Held {
		t.Fatalf("after a deploy start: %+v, want not held", st)
	}
}

// Held on an already-idle worktree still holds it: the caller's next step
// destroys the data whether or not a backend happened to be running.
func TestStopRouteHoldOnIdle(t *testing.T) {
	fx := newStaticProxy(t)
	rec := postStopHeld(fx.proxy, "alpha")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", rec.Code, rec.Body.String())
	}
	if st := decodeStatus(t, rec); st.State != "idle" || !st.Held {
		t.Fatalf("status = %+v, want idle and held", st)
	}
	// A plain stop is not a hold.
	fx2 := newStaticProxy(t)
	if st := decodeStatus(t, postStop(fx2.proxy, "alpha")); st.Held {
		t.Fatalf("plain stop: %+v, want not held", st)
	}
}
