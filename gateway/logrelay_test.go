package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestMain lets the test binary act as the relay: startLogRelay re-executes
// os.Executable(), which under `go test` is this binary, not the gateway.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == logRelayFlag {
		os.Exit(logRelayMain(os.Args[2:]))
	}
	os.Exit(m.Run())
}

func TestRunLogRelayRotatesWholeLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "svc.log")
	in := strings.NewReader("aaaa\nbbbb\ncccc\ntail")
	if err := runLogRelay(path, in, 10, 2); err != nil {
		t.Fatal(err)
	}
	read := func(p string) string {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	// 5-byte lines, 10-byte cap: two lines per file, never one split across a
	// rotation; the unterminated tail at EOF is still written.
	if got := read(path); got != "cccc\ntail" {
		t.Fatalf("live = %q", got)
	}
	if got := read(path + ".1"); got != "aaaa\nbbbb\n" {
		t.Fatalf(".1 = %q", got)
	}
}

// waitForFile polls (test-only) until path holds want or the deadline passes.
func waitForFile(t *testing.T, path, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		b, err := os.ReadFile(path)
		if err == nil && string(b) == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s = %q (err %v), want %q", path, b, err, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A daemon started by the command keeps writing through the relay after the
// start command itself has returned — the relay outlives the start.
func TestStartCommandHandsDaemonTheRelay(t *testing.T) {
	logDir := t.TempDir()
	sup := &Supervisor{env: testChildEnv(t), logDir: logDir}
	cfg := ServiceConfig{Name: "svc", Start: []string{"/bin/sh", "-c",
		`echo "$0=$1" >&3; (sleep 0.3; echo later >&3) </dev/null >/dev/null 2>&1 &`}}
	if err := sup.execStartCommand(cfg); err != nil {
		t.Fatal(err)
	}
	waitForFile(t, serviceLogPath(logDir, "svc"), "--log-fd=3\nlater\n")
}

// A start that only reattaches never writes: the relay reads EOF and exits
// without creating the file.
func TestReattachLeavesNoFile(t *testing.T) {
	logDir := t.TempDir()
	sup := &Supervisor{env: testChildEnv(t), logDir: logDir}
	if err := sup.execStartCommand(ServiceConfig{Name: "svc", Start: []string{"/usr/bin/true"}}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if _, err := os.Stat(serviceLogPath(logDir, "svc")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("relay created the log with nothing written: %v", err)
	}
}
