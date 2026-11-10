package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The entry the writer builds is the shape the TypeScript side reads:
// testdata/main-deploy-failed-entry.json is parsed by the converge plugin's
// kind test (plugins/build/plugins/converge/core/kind.test.ts).
func TestMainDeployEntryMatchesTheGolden(t *testing.T) {
	code := 1
	f := mainDeployFailed{
		ExitCode: &code,
		Causes:   []string{"ref advanced"},
		Tail: []string{
			"[converge 2026-11-10T12:00:00.000Z] building equin at 2baf0e2a3",
			"error: connect ECONNREFUSED /tmp/.s.PGSQL.6432",
		},
		Checkout:  "/x/equin",
		Log:       "/x/.equin/logs/gateway/deploy/main.log",
		StartedAt: 1794312000000,
		EndedAt:   1794312004000,
	}
	got, err := json.Marshal(newMainDeployEntry(f, 1234))
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile(filepath.Join("testdata", "main-deploy-failed-entry.json"))
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
		t.Fatalf("entry drifted from testdata/main-deploy-failed-entry.json:\n got %s", got)
	}
}

// fakeCheckout is a directory shaped like main's checkout: a .git dir with
// refs/heads/main, and an `equin` CLI file.
func fakeCheckout(t *testing.T, ref string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".git", "refs", "heads"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeRef(t, dir, ref)
	if err := os.WriteFile(filepath.Join(dir, "equin"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

// writeRef moves refs/heads/main the way git does: a lock file renamed over it.
func writeRef(t *testing.T, checkout, ref string) {
	t.Helper()
	heads := filepath.Join(checkout, ".git", "refs", "heads")
	if err := os.WriteFile(filepath.Join(heads, "main.lock"), []byte(ref+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(heads, "main.lock"), filepath.Join(heads, "main")); err != nil {
		t.Fatal(err)
	}
}

// testDeployer runs `sh -c script` as its convergence run, counting runs.
func testDeployer(t *testing.T, script string) (*mainDeployer, string, string, *atomic.Int32) {
	t.Helper()
	checkout := fakeCheckout(t, "aaaa")
	logDir, outbox := t.TempDir(), t.TempDir()
	d, err := newMainDeployer(checkout, ChildEnv{}, logDir, outbox)
	if err != nil {
		t.Fatal(err)
	}
	d.debounce = 50 * time.Millisecond
	runs := &atomic.Int32{}
	d.spawn = func(logFile *os.File) (*exec.Cmd, error) {
		runs.Add(1)
		cmd := exec.Command("sh", "-c", script)
		cmd.Stdout = logFile
		cmd.Stderr = logFile
		return cmd, cmd.Start()
	}
	return d, logDir, outbox, runs
}

func waitRunEnded(t *testing.T, d *mainDeployer) {
	t.Helper()
	select {
	case <-d.runEnded:
	case <-time.After(5 * time.Second):
		t.Fatal("no run ended")
	}
}

// Quiet for the debounce, then exactly one run, however many edges arrived.
func TestMainDeployCoalescesABurstIntoOneRun(t *testing.T) {
	d, _, outbox, runs := testDeployer(t, "exit 0")
	for range 5 {
		d.Trigger("ref advanced")
	}
	waitRunEnded(t, d)
	time.Sleep(150 * time.Millisecond)
	if n := runs.Load(); n != 1 {
		t.Fatalf("runs: %d, want 1", n)
	}
	if st := d.Status(); st.Last == nil || st.Last.Outcome != "ok" || len(st.Last.Causes) != 5 {
		t.Fatalf("status: %+v", st.Last)
	}
	if es := readOutbox[mainDeployFailed](t, outbox); len(es) != 0 {
		t.Fatalf("a run that succeeded filed %d reports", len(es))
	}
}

// An edge during a run is remembered and runs after it — one run at a time,
// and never dropped.
func TestMainDeployRunsAgainForAnEdgeDuringARun(t *testing.T) {
	d, _, _, runs := testDeployer(t, "sleep 0.3")
	d.Trigger("gateway boot")
	deadline := time.Now().Add(2 * time.Second)
	for !d.Status().Running {
		if time.Now().After(deadline) {
			t.Fatal("first run never started")
		}
		time.Sleep(10 * time.Millisecond)
	}
	d.Trigger("ref advanced")
	d.Trigger("ref advanced")
	if st := d.Status(); !st.Running || len(st.Pending) != 2 {
		t.Fatalf("during the run: %+v", st)
	}
	waitRunEnded(t, d)
	waitRunEnded(t, d)
	if n := runs.Load(); n != 2 {
		t.Fatalf("runs: %d, want 2", n)
	}
	if st := d.Status(); st.Last == nil || !reflect.DeepEqual(st.Last.Causes, []string{"ref advanced", "ref advanced"}) {
		t.Fatalf("second run's causes: %+v", st.Last)
	}
}

// A failed run is a report carrying this run's own output only.
func TestMainDeployFailureIsReportedWithItsOwnTail(t *testing.T) {
	d, _, outbox, _ := testDeployer(t, "echo first-run; exit 0")
	d.Trigger("gateway boot")
	waitRunEnded(t, d)
	d.spawn = func(logFile *os.File) (*exec.Cmd, error) {
		cmd := exec.Command("sh", "-c", "echo deciding; echo boom >&2; exit 3")
		cmd.Stdout = logFile
		cmd.Stderr = logFile
		return cmd, cmd.Start()
	}
	d.Trigger("ref advanced")
	waitRunEnded(t, d)
	es := readOutbox[mainDeployFailed](t, outbox)
	if len(es) != 1 {
		t.Fatalf("reports: %d, want 1", len(es))
	}
	f := es[0].Data
	if f.ExitCode == nil || *f.ExitCode != 3 || f.Signal != nil || f.SpawnError != nil {
		t.Fatalf("status: %+v", f)
	}
	tail := strings.Join(f.Tail, "\n")
	if strings.Contains(tail, "first-run") || !strings.Contains(tail, "deciding") || !strings.Contains(tail, "boom") {
		t.Fatalf("tail: %q", tail)
	}
	if !reflect.DeepEqual(f.Causes, []string{"ref advanced"}) {
		t.Fatalf("causes: %v", f.Causes)
	}
}

// A run that cannot start is a report too, and leaves no run going.
func TestMainDeploySpawnFailureIsReported(t *testing.T) {
	d, _, outbox, _ := testDeployer(t, "")
	d.spawn = func(logFile *os.File) (*exec.Cmd, error) {
		cmd := exec.Command(filepath.Join(t.TempDir(), "missing"))
		return cmd, cmd.Start()
	}
	d.Trigger("gateway boot")
	waitRunEnded(t, d)
	es := readOutbox[mainDeployFailed](t, outbox)
	if len(es) != 1 || es[0].Data.SpawnError == nil {
		t.Fatalf("reports: %+v", es)
	}
	if d.Status().Running {
		t.Fatal("a run that never started is still running")
	}
}

// The watch: boot is an edge, a moved ref is an edge, a rewrite of the same
// ref is not.
func TestMainDeployWatchesRefsHeadsMain(t *testing.T) {
	d, _, _, runs := testDeployer(t, "exit 0")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := d.Start(ctx); err != nil {
		t.Fatal(err)
	}
	waitRunEnded(t, d)
	writeRef(t, d.checkout, "aaaa") // same value: not an edge
	writeRef(t, d.checkout, "bbbb")
	waitRunEnded(t, d)
	time.Sleep(200 * time.Millisecond)
	if n := runs.Load(); n != 2 {
		t.Fatalf("runs: %d, want 2 (boot, advance)", n)
	}
	if st := d.Status(); st.Ref != "bbbb" || !reflect.DeepEqual(st.Last.Causes, []string{"ref advanced"}) {
		t.Fatalf("status: ref %q last %+v", st.Ref, st.Last)
	}
}

func TestReadMainRefFallsBackToPackedRefs(t *testing.T) {
	checkout := fakeCheckout(t, "aaaa")
	gitDir := filepath.Join(checkout, ".git")
	if err := os.Remove(filepath.Join(gitDir, "refs", "heads", "main")); err != nil {
		t.Fatal(err)
	}
	packed := "# pack-refs with: peeled fully-peeled sorted\ncccc refs/heads/feature\ndddd refs/heads/main\n"
	if err := os.WriteFile(filepath.Join(gitDir, "packed-refs"), []byte(packed), 0o644); err != nil {
		t.Fatal(err)
	}
	ref, err := readMainRef(gitDir)
	if err != nil || ref != "dddd" {
		t.Fatalf("ref %q err %v", ref, err)
	}
}

func TestNewMainDeployerRefusesALinkedWorktree(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".git"), []byte("gitdir: /x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := newMainDeployer(dir, ChildEnv{}, t.TempDir(), t.TempDir()); err == nil || !strings.Contains(err.Error(), "linked worktree") {
		t.Fatalf("err: %v", err)
	}
}
