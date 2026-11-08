package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// scriptedProbe fails while down is set, and answers otherwise.
type scriptedProbe struct{ down atomic.Bool }

func (p *scriptedProbe) Check(time.Duration) error {
	if p.down.Load() {
		return errors.New("dial unix /x/.s.PGSQL.5433: connect: connection refused")
	}
	return nil
}

func (p *scriptedProbe) String() string { return "unix /x/.s.PGSQL.5433" }

// The entry the writer builds is the shape the TypeScript side reads:
// testdata/service-down-entry.json is parsed by the service-down kind's own
// test (plugins/debug/plugins/service-down/core/kind.test.ts).
func TestServiceDownEntryMatchesTheGolden(t *testing.T) {
	up := int64(1794150000000)
	errText := "start command failed: exit status 1: pg: data dir locked"
	d := serviceDown{
		Service:       "postgres",
		Probe:         "unix /x/.s.PGSQL.5433",
		ProbeError:    "dial unix /x/.s.PGSQL.5433: connect: connection refused",
		UpSince:       &up,
		DetectedAt:    1794153600000,
		Outcome:       outcomeCrashed,
		SettledAt:     1794153604200,
		RestartError:  &errText,
		RestartOutput: []string{"pg: removing stale postmaster.pid", "pg: data dir locked"},
		LogPath:       "/x/logs/gateway/services/postgres.log",
		LogTail: []string{
			"2026-11-08 10:00:00.000 CET [123] LOG:  server process (PID 456) was terminated by signal 9: Killed",
			"2026-11-08 10:00:00.001 CET [123] LOG:  terminating any other active server processes",
		},
	}
	got, err := json.Marshal(newServiceDownEntry(d, 1234, "/repo"))
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile(filepath.Join("testdata", "service-down-entry.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(g, w) {
		t.Fatalf("entry drifted from testdata/service-down-entry.json:\n got %s", got)
	}
	if want := "service postgres stopped answering after 1h0m0s up (dial unix /x/.s.PGSQL.5433: connect: connection refused); re-start failed after 4.2s, left crashed: start command failed: exit status 1: pg: data dir locked"; serviceDownMessage(d) != want {
		t.Fatalf("message = %q", serviceDownMessage(d))
	}
}

func TestReadLogTailKeepsTheLastLines(t *testing.T) {
	dir := t.TempDir()
	if got, err := readLogTail(filepath.Join(dir, "missing.log")); err != nil || len(got) != 0 || got == nil {
		t.Fatalf("missing file: %q, %v — want an empty tail", got, err)
	}
	var b strings.Builder
	for i := 0; i < 5000; i++ {
		b.WriteString(strings.Repeat("x", 100))
		b.WriteString("\n")
	}
	b.WriteString("the last line\n")
	path := filepath.Join(dir, "big.log")
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := readLogTail(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != crashTailLines || got[len(got)-1] != "the last line" || got[0] != strings.Repeat("x", 100) {
		t.Fatalf("tail = %d lines, last %q, first %q", len(got), got[len(got)-1], got[0])
	}
}

// watchedService arms a real watchdog (1 s tick) on a running service whose
// probe the test controls, with a log channel already holding the daemon's
// last words.
func watchedService(t *testing.T, start string) (*Supervisor, *scriptedProbe, string) {
	t.Helper()
	probe := &scriptedProbe{}
	svc := newTestService("svc", []string{"/bin/sh", "-c", start}, probe)
	svc.config.Watchdog = &WatchdogConfig{IntervalSec: 1}
	logDir, outbox := t.TempDir(), t.TempDir()
	logPath := serviceLogPath(logDir, "svc")
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(logPath, []byte("svc: serving\nsvc: FATAL out of file descriptors\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	sup := &Supervisor{services: []*Service{svc}, env: testChildEnv(t), logDir: logDir, outboxDir: outbox}
	svc.setState(ServiceRunning)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel(); sup.StopAll() })
	sup.startWatchdog(ctx, svc)
	return sup, probe, outbox
}

func awaitServiceReport(t *testing.T, outbox string) outboxEntryOf[serviceDown] {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if es := readOutbox[serviceDown](t, outbox); len(es) > 0 {
			if len(es) != 1 {
				t.Fatalf("outbox holds %d entries, want 1", len(es))
			}
			return es[0]
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("no service-down entry was filed")
	return outboxEntryOf[serviceDown]{}
}

// A service that stops answering mid-session and comes back after its start
// command ran is filed as a recovered outage: the probe's error, the start
// command's own output, and the daemon's log tail as of the detection.
func TestWatchdogFilesARecoveredOutage(t *testing.T) {
	sup, probe, outbox := watchedService(t, `echo "svc: stale pidfile; starting"`)
	probe.down.Store(true)
	go func() {
		// Back up shortly after detection: the re-start's readiness wait polls
		// every probeInterval, so the outage settles as recovered.
		time.Sleep(1500 * time.Millisecond)
		probe.down.Store(false)
	}()
	e := awaitServiceReport(t, outbox)
	d := e.Data
	if e.Kind != serviceDownKind || d.Service != "svc" || d.Outcome != outcomeRecovered || d.RestartError != nil {
		t.Fatalf("entry = %+v", e)
	}
	if !strings.Contains(d.ProbeError, "connection refused") || d.Probe != "unix /x/.s.PGSQL.5433" {
		t.Fatalf("probe = %q, error %q", d.Probe, d.ProbeError)
	}
	if !reflect.DeepEqual(d.RestartOutput, []string{"svc: stale pidfile; starting"}) {
		t.Fatalf("restart output = %q", d.RestartOutput)
	}
	if !reflect.DeepEqual(d.LogTail, []string{"svc: serving", "svc: FATAL out of file descriptors"}) {
		t.Fatalf("log tail = %q", d.LogTail)
	}
	if d.UpSince == nil || d.DetectedAt < *d.UpSince || d.SettledAt < d.DetectedAt {
		t.Fatalf("times: up %v detected %d settled %d", d.UpSince, d.DetectedAt, d.SettledAt)
	}
	if !strings.Contains(e.Message, "re-started, answering again") {
		t.Fatalf("message = %q", e.Message)
	}
	if got := sup.Get("svc").State; got != "running" {
		t.Fatalf("state = %q, want running", got)
	}
}

// A re-start that fails leaves the service crashed (as before) and is filed
// with the start command's failure.
func TestWatchdogFilesAnOutageLeftCrashed(t *testing.T) {
	sup, probe, outbox := watchedService(t, `echo "svc: data dir locked" >&2; exit 1`)
	probe.down.Store(true)
	e := awaitServiceReport(t, outbox)
	d := e.Data
	if d.Outcome != outcomeCrashed || d.RestartError == nil || !strings.Contains(*d.RestartError, "data dir locked") {
		t.Fatalf("entry = %+v", e)
	}
	if !reflect.DeepEqual(d.RestartOutput, []string{"svc: data dir locked"}) {
		t.Fatalf("restart output = %q", d.RestartOutput)
	}
	if !strings.Contains(e.Message, "left crashed") {
		t.Fatalf("message = %q", e.Message)
	}
	if snap := sup.Get("svc"); snap.State != "crashed" || !strings.Contains(snap.Error, "data dir locked") {
		t.Fatalf("snapshot = %+v", snap)
	}
}

// A healthy service files nothing.
func TestWatchdogFilesNothingWhileTheServiceAnswers(t *testing.T) {
	_, _, outbox := watchedService(t, `exit 0`)
	time.Sleep(2500 * time.Millisecond)
	if n := len(readOutbox[serviceDown](t, outbox)); n != 0 {
		t.Fatalf("outbox holds %d entries, want none", n)
	}
}

// A start command that never exits is bounded: at startCommandTimeout it is
// killed with every process in its group, and the outage is filed as crashed
// with the bound and the output so far — instead of the watchdog blocking on
// it forever, the service down and nothing filed.
func TestWatchdogFilesAHungStartCommand(t *testing.T) {
	helperPid := filepath.Join(t.TempDir(), "helper.pid")
	sup, probe, outbox := watchedService(t, `echo "svc: waiting on the cluster"; sleep 600 & echo $! > `+helperPid+`; wait`)
	sup.startCommandTimeout = time.Second
	probe.down.Store(true)
	e := awaitServiceReport(t, outbox)
	d := e.Data
	if d.Outcome != outcomeCrashed || d.RestartError == nil || !strings.Contains(*d.RestartError, "did not exit within 1s") {
		t.Fatalf("entry = %+v", e)
	}
	if !reflect.DeepEqual(d.RestartOutput, []string{"svc: waiting on the cluster"}) {
		t.Fatalf("restart output = %q", d.RestartOutput)
	}
	if snap := sup.Get("svc"); snap.State != "crashed" || !strings.Contains(snap.Error, "did not exit within 1s") {
		t.Fatalf("snapshot = %+v", snap)
	}
	// The helper the command started went with it: the group was killed.
	raw, err := os.ReadFile(helperPid)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for syscall.Kill(pid, 0) == nil {
		if time.Now().After(deadline) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
			t.Fatalf("helper %d outlived its start command's group", pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A start command that exits while something it started keeps its output pipe
// (a daemon that did not detach its stdio) fails after startCommandWaitDelay,
// naming that — instead of CombinedOutput waiting out the daemon's life.
func TestStartCommandFailsWhenAChildKeepsItsOutput(t *testing.T) {
	logDir := t.TempDir()
	sup := &Supervisor{env: testChildEnv(t), logDir: logDir}
	helperPid := filepath.Join(t.TempDir(), "helper.pid")
	t.Cleanup(func() {
		if raw, err := os.ReadFile(helperPid); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil {
				_ = syscall.Kill(pid, syscall.SIGKILL)
			}
		}
	})
	start := time.Now()
	_, err := sup.execStartCommand(context.Background(), ServiceConfig{
		Name:  "svc",
		Start: []string{"/bin/sh", "-c", `sleep 600 & echo $! > ` + helperPid + `; echo "svc: started"`},
	})
	if err == nil || !strings.Contains(err.Error(), "still held its output pipe") {
		t.Fatalf("err = %v", err)
	}
	if took := time.Since(start); took > startCommandWaitDelay+5*time.Second {
		t.Fatalf("took %s", took)
	}
}
