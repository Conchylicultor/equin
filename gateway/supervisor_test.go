package main

import (
	"context"
	"encoding/json"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newTestService builds a Service in-process, bypassing NewSupervisor so a test
// never needs a database.json on disk.
func newTestService(name string, start []string, probe ReadyProbe) *Service {
	return &Service{
		config: ServiceConfig{Name: name, Start: start},
		probe:  probe,
		state:  ServiceStopped,
	}
}

// TestStartFailureRecordsReason is the incident regression: a start command that
// fails used to leave the service `crashed` with nothing attached, so
// /gateway/services could report the fact of the failure but never its cause
// (`initdb: error: cannot be run as root`). The stderr text must survive into
// the snapshot.
//
// The probe points at a socket path nothing ever binds, but readiness is never
// reached — execStartCommand fails first — so this test does not wait out
// startReadyTimeout.
func TestStartFailureRecordsReason(t *testing.T) {
	svc := newTestService("boom",
		[]string{"/bin/sh", "-c", "echo initdb-refused-to-run >&2; exit 1"},
		UnixProbe{Path: filepath.Join(t.TempDir(), "never.sock")},
	)
	sup := &Supervisor{services: []*Service{svc}, env: testChildEnv(t), logDir: t.TempDir()}

	start := time.Now()
	err := sup.StartAll(context.Background())
	if err == nil {
		t.Fatal("StartAll should fail when the start command exits non-zero")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("start failure should not wait on the readiness probe; took %s", elapsed)
	}

	snap := sup.Get("boom")
	if snap == nil {
		t.Fatal("Get(\"boom\") returned nil")
	}
	if snap.State != "crashed" {
		t.Fatalf("state = %q, want crashed", snap.State)
	}
	if !strings.Contains(snap.Error, "initdb-refused-to-run") {
		t.Fatalf("snapshot error should carry the command's stderr, got %q", snap.Error)
	}

	// List() must carry the same reason — it is the endpoint an operator hits
	// first, and a reason visible only via the per-service route is half a fix.
	list := sup.List()
	if len(list) != 1 || !strings.Contains(list[0].Error, "initdb-refused-to-run") {
		t.Fatalf("List() should carry the reason too, got %+v", list)
	}
}

// TestReadyTimeoutRecordsReason: the start command succeeding but the daemon
// never becoming reachable is the other crash path out of startService, and it
// must also name itself. startReadyTimeout is a package const, so the deadline
// is shortened by cancelling the context instead.
func TestReadyTimeoutRecordsReason(t *testing.T) {
	svc := newTestService("silent",
		[]string{"/bin/sh", "-c", "exit 0"},
		UnixProbe{Path: filepath.Join(t.TempDir(), "never.sock")},
	)
	sup := &Supervisor{services: []*Service{svc}, env: testChildEnv(t), logDir: t.TempDir()}

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := sup.StartAll(ctx); err == nil {
		t.Fatal("StartAll should fail when the service never becomes ready")
	}

	snap := sup.Get("silent")
	if snap.State != "crashed" {
		t.Fatalf("state = %q, want crashed", snap.State)
	}
	if !strings.Contains(snap.Error, "did not become ready") {
		t.Fatalf("snapshot error should name the readiness timeout, got %q", snap.Error)
	}
}

// TestHealthyServiceSnapshotHasNoErrorKey pins the `omitempty` contract: a
// running service's JSON must stay byte-identical to what it was before the
// field existed, so no consumer can start keying off a present-but-empty
// `error`.
func TestHealthyServiceSnapshotHasNoErrorKey(t *testing.T) {
	socketPath := filepath.Join(shortTempDir(t), "up.sock")
	l, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}
	t.Cleanup(func() { _ = l.Close() })

	svc := newTestService("healthy", []string{"/bin/sh", "-c", "exit 0"}, UnixProbe{Path: socketPath})
	sup := &Supervisor{services: []*Service{svc}, env: testChildEnv(t), logDir: t.TempDir()}

	ctx, cancel := context.WithCancel(context.Background())
	// Stop the watchdog goroutine StartAll arms before the test's listener dies.
	defer func() { cancel(); sup.StopAll() }()

	if err := sup.StartAll(ctx); err != nil {
		t.Fatalf("StartAll: %v", err)
	}

	snap := sup.Get("healthy")
	if snap.State != "running" {
		t.Fatalf("state = %q, want running", snap.State)
	}
	if snap.Error != "" {
		t.Fatalf("healthy service should carry no error, got %q", snap.Error)
	}

	encoded, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if got, want := string(encoded), `{"name":"healthy","state":"running"}`; got != want {
		t.Fatalf("healthy JSON = %s, want %s", got, want)
	}
}

// TestRecoveryClearsReason: reaching ServiceRunning drops a stale reason, so a
// service the watchdog brought back never keeps advertising the crash it
// already recovered from.
func TestRecoveryClearsReason(t *testing.T) {
	svc := newTestService("flappy", nil, UnixProbe{Path: "/nonexistent"})
	svc.setCrashed(context.DeadlineExceeded)
	if svc.snapshot().Error == "" {
		t.Fatal("setCrashed should record a reason")
	}
	svc.setState(ServiceRunning)
	if got := svc.snapshot().Error; got != "" {
		t.Fatalf("running service should have no reason, got %q", got)
	}
}
