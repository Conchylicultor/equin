package main

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

// captureSlog routes the default logger into a buffer for the test's duration.
func captureSlog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// A backend that misses its readiness deadline is killed, and the gateway log
// says so: which backend, the deadline, how long it waited, and the outcome.
func TestAbandonUnreadyBackendLogsTheKill(t *testing.T) {
	fx := newStaticProxy(t)
	wt := fx.reg.Resolve("alpha")
	bk, pid := runFakeBackend(t, wt)
	logs := captureSlog(t)

	wt.abandonUnreadyBackend(bk, "hot restart",
		readyWait{deadline: 15 * time.Second, waited: 15*time.Second + 40*time.Millisecond},
		errors.New("readiness timeout after 15s (backend never answered HTTP)"))

	select {
	case <-bk.exitCh:
	default:
		t.Fatal("abandoned backend must have exited")
	}
	waitGone(t, pid, time.Second)
	line := logs.String()
	for _, want := range []string{
		"backend abandoned: not ready by its deadline", "worktree=alpha", "phase=\"hot restart\"",
		"deadline=15s", "waited=15.04s", "outcome=\"killed (SIGKILL), exited\"", "readiness timeout after 15s",
	} {
		if !strings.Contains(line, want) {
			t.Errorf("log missing %q:\n%s", want, line)
		}
	}
}

// A backend that crashed before ready is not killed; the line says it exited
// on its own.
func TestAbandonUnreadyBackendSaysWhenItExitedOnItsOwn(t *testing.T) {
	fx := newStaticProxy(t)
	wt := fx.reg.Resolve("alpha")
	bk := &backend{exitCh: make(chan struct{}), socketPath: wt.primarySocketPath()}
	close(bk.exitCh)
	logs := captureSlog(t)

	wt.abandonUnreadyBackend(bk, "cold start", readyWait{deadline: 15 * time.Second, waited: time.Second},
		withStderrTail(errExitedBeforeReady, nil))

	if !strings.Contains(logs.String(), "outcome=\"exited on its own before ready\"") {
		t.Fatalf("log = %s", logs.String())
	}
}
