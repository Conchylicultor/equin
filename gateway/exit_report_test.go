package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// The entries are byte-for-byte the shapes the TypeScript side reads:
// testdata/backend-exit-entry.json and testdata/backend-crash-loop-entry.json
// are parsed by the backend-crash plugin's own tests (core/exit-kind.test.ts,
// core/loop-kind.test.ts). Change one side and the other's test fails.
func assertGolden(t *testing.T, e outboxEntry, file string) {
	t.Helper()
	got, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile(filepath.Join("testdata", file))
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
		t.Fatalf("entry drifted from testdata/%s:\n got %s", file, got)
	}
}

func goldenEntry(kind, msg string, data any, at int64) outboxEntry {
	return outboxEntry{Version: 1, Kind: kind, Message: msg, Data: data, OccurredAt: at,
		Writer: outboxWriter{Pid: 1234, Checkout: "/repo/plugins/framework/plugins/server-core"}}
}

func TestBackendExitEntryMatchesTheGolden(t *testing.T) {
	ready := int64(1794157615000)
	e := newBackendExit("main", 49750, 1, 1794157606287, 1794157613456+7000, &ready,
		"equin · server · main",
		[]string{
			"[process-crash] uncaughtException: error: conversations_ext_sdk_agent_stop.updated_at is derived (declared by its touchedBy); do not write it",
			"      at processTicksAndRejections (native:7:39)",
		}, true)
	assertGolden(t, goldenEntry(backendExitKind, exitMessage(e), e, e.ExitedAt), "backend-exit-entry.json")
}

func TestBackendCrashLoopEntryMatchesTheGolden(t *testing.T) {
	ended := int64(1794159361000 + 300000)
	state := "running"
	l := backendCrashLoop{
		Worktree: "main", State: "ended", Deaths: 83,
		FirstDeathAt: 1794157613456, LastDeathAt: 1794159361000,
		EndedAt: &ended, StateAtEnd: &state,
		WindowMs: 300000, Threshold: 3,
		Recent: []loopDeath{
			{At: 1794159350000, UpMs: 8100, Cause: "exit 1", Ready: true},
			{At: 1794159361000, UpMs: 7400, Cause: "exit 1", Ready: true},
		},
		LastStderrTail:     []string{"error: conversations_ext_sdk_agent_stop.updated_at is derived (declared by its touchedBy); do not write it"},
		LastStderrComplete: true,
	}
	assertGolden(t, goldenEntry(backendCrashLoopKind, loopMessage(l), l, ended), "backend-crash-loop-entry.json")
}

func TestExitMessageSaysBootOrServing(t *testing.T) {
	booting := newBackendExit("alpha", 1, 1, 0, 3000, nil, "bun", nil, true)
	if got, want := exitMessage(booting), "backend alpha exited with code 1 while booting, after 3s"; got != want {
		t.Fatalf("message = %q, want %q", got, want)
	}
	if booting.StderrTail == nil {
		t.Fatal("a nil tail must marshal as [], not null")
	}
	ready := int64(2000)
	serving := newBackendExit("alpha", 1, 1, 0, 9000, &ready, "bun", nil, true)
	if got, want := exitMessage(serving), "backend alpha exited with code 1 7s after ready (9s up)"; got != want {
		t.Fatalf("message = %q, want %q", got, want)
	}
}

// loopRecorder collects what a crashLoops files.
type loopRecorder struct {
	mu    sync.Mutex
	ended []backendCrashLoop
	done  chan struct{}
}

func (r *loopRecorder) onEnd(l backendCrashLoop) {
	r.mu.Lock()
	r.ended = append(r.ended, l)
	r.mu.Unlock()
	r.done <- struct{}{}
}

// Every death is counted; a streak files at the threshold, again each time it
// doubles, and once more when the window passes with no further death. A
// death after a quiet window starts a new streak.
func TestCrashLoopsFileAtThresholdDoublingAndEnd(t *testing.T) {
	c := newCrashLoops("main")
	c.window = 150 * time.Millisecond
	rec := &loopRecorder{done: make(chan struct{}, 4)}
	var filedAt []int
	at := time.Now().UnixMilli()
	for i := 1; i <= 13; i++ {
		l, ok := c.record(loopDeath{At: at + int64(i), UpMs: 5000, Cause: "exit 1", Ready: true},
			[]string{"tail"}, true, rec.onEnd)
		if ok {
			if l.State != "looping" || l.Deaths != i || l.EndedAt != nil || l.StateAtEnd != nil {
				t.Fatalf("death %d filed %+v", i, l)
			}
			filedAt = append(filedAt, i)
		}
	}
	if want := []int{3, 6, 12}; !reflect.DeepEqual(filedAt, want) {
		t.Fatalf("filed at deaths %v, want %v", filedAt, want)
	}
	select {
	case <-rec.done:
	case <-time.After(2 * time.Second):
		t.Fatal("the loop's end was never filed")
	}
	rec.mu.Lock()
	end := rec.ended[0]
	rec.mu.Unlock()
	if end.State != "ended" || end.Deaths != 13 || end.EndedAt == nil ||
		*end.EndedAt != end.LastDeathAt+150 || len(end.Recent) != 13 {
		t.Fatalf("end = %+v", end)
	}

	// Two deaths far apart are not a loop, and file nothing — not even an end.
	for i := 0; i < 2; i++ {
		if _, ok := c.record(loopDeath{At: time.Now().UnixMilli(), Cause: "exit 1"}, nil, true, rec.onEnd); ok {
			t.Fatal("two deaths filed a loop")
		}
	}
	time.Sleep(400 * time.Millisecond)
	if len(rec.done) != 0 {
		t.Fatal("a streak under the threshold filed an end")
	}
}

// Deaths recorded out of order (each report waits on its own stderr) still
// list oldest first, and the loop's span is from the earliest to the latest.
func TestCrashLoopsSortOutOfOrderDeaths(t *testing.T) {
	c := newCrashLoops("main")
	c.window = time.Hour
	var l backendCrashLoop
	var ok bool
	for _, at := range []int64{1000, 3000, 2000} {
		l, ok = c.record(loopDeath{At: at, Cause: fmt.Sprintf("exit %d", at)}, nil, true, func(backendCrashLoop) {})
	}
	if !ok || l.FirstDeathAt != 1000 || l.LastDeathAt != 3000 {
		t.Fatalf("loop = %+v (filed %v)", l, ok)
	}
	if got := []int64{l.Recent[0].At, l.Recent[1].At, l.Recent[2].At}; !reflect.DeepEqual(got, []int64{1000, 2000, 3000}) {
		t.Fatalf("recent = %v, want oldest first", got)
	}
	if !strings.Contains(loopMessage(l), "last: exit 3000") {
		t.Fatalf("message = %q", loopMessage(l))
	}
}

// A death that lands after the window but before the end timer ran still ends
// the old loop (filed) and starts a new streak at 1.
func TestCrashLoopsLateDeathEndsTheOldLoop(t *testing.T) {
	c := newCrashLoops("main")
	c.window = time.Hour // the timer never fires in this test
	rec := &loopRecorder{done: make(chan struct{}, 2)}
	for i := int64(0); i < 3; i++ {
		c.record(loopDeath{At: i, Cause: "exit 1"}, nil, true, rec.onEnd)
	}
	late := time.Hour.Milliseconds() + 10
	if _, ok := c.record(loopDeath{At: late, Cause: "exit 1"}, nil, true, rec.onEnd); ok {
		t.Fatal("the first death of a new streak filed a loop")
	}
	select {
	case <-rec.done:
	case <-time.After(2 * time.Second):
		t.Fatal("the old loop's end was not filed")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.streak != 1 || c.firstDeathAt != late {
		t.Fatalf("new streak = %d from %d", c.streak, c.firstDeathAt)
	}
}

// A backend that exits by code at boot — before its readiness — is filed as
// backend-exit with its code, no readyAt, and its own stderr.
func TestBackendExitAtBootIsReported(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	outbox := t.TempDir()
	pf.wt.cfg.ReportOutboxDir = outbox
	spec := *pf.wt.Spec()
	spec.Command = []string{"/bin/sh", "-c", `echo "error: boot write failed" >&2; exit 4`}
	pf.wt.UpdateSpec(&spec)

	if _, err := pf.wt.Ensure(context.Background(), StartBackground, "test"); !errors.Is(err, ErrSpawnFailed) {
		t.Fatalf("Ensure: err = %v, want ErrSpawnFailed", err)
	}
	e := waitOutboxKind[backendExit](t, outbox, backendExitKind, 1)[0]
	if e.Data.Worktree != "alpha" || e.Data.ExitCode != 4 || e.Data.ReadyAt != nil {
		t.Fatalf("entry = %+v", e)
	}
	if !e.Data.StderrComplete || !reflect.DeepEqual(e.Data.StderrTail, []string{"error: boot write failed"}) {
		t.Fatalf("stderr tail = %q", e.Data.StderrTail)
	}
	if !strings.Contains(e.Message, "exited with code 4 while booting") {
		t.Fatalf("message = %q", e.Message)
	}
}

// The 2026-11-08 shape: a backend that comes up, serves, then exits by code on
// its own, respawned by the next request each time. Every death is filed, and
// the third makes a loop.
func TestServingBackendThatKeepsExitingIsALoop(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	outbox := t.TempDir()
	pf.wt.cfg.ReportOutboxDir = outbox
	spec := *pf.wt.Spec()
	spec.Command = append(append([]string{}, spec.Command...), "die-after-ready")
	pf.wt.UpdateSpec(&spec)

	for i := 0; i < crashLoopThreshold; i++ {
		bk, err := pf.wt.Ensure(context.Background(), StartBrowser, "test")
		if err != nil {
			t.Fatalf("Ensure %d: %v", i, err)
		}
		select {
		case <-bk.exitCh:
		case <-time.After(5 * time.Second):
			t.Fatalf("backend %d did not exit", i)
		}
		// onBackendExit has run (exitCh closes after it): the next Ensure respawns.
	}
	exits := waitOutboxKind[backendExit](t, outbox, backendExitKind, crashLoopThreshold)
	for _, e := range exits {
		if e.Data.ExitCode != 3 || e.Data.ReadyAt == nil || *e.Data.ReadyAt < e.Data.StartedAt {
			t.Fatalf("exit = %+v", e.Data)
		}
		if !strings.Contains(e.Message, "after ready") {
			t.Fatalf("message = %q", e.Message)
		}
	}
	loop := waitOutboxKind[backendCrashLoop](t, outbox, backendCrashLoopKind, 1)[0]
	if loop.Data.State != "looping" || loop.Data.Deaths != crashLoopThreshold || len(loop.Data.Recent) != crashLoopThreshold {
		t.Fatalf("loop = %+v", loop.Data)
	}
	for _, d := range loop.Data.Recent {
		if d.Cause != "exit 3" || !d.Ready {
			t.Fatalf("death = %+v", d)
		}
	}
	if !reflect.DeepEqual(loop.Data.LastStderrTail, []string{"error: a write after ready failed"}) {
		t.Fatalf("last tail = %q", loop.Data.LastStderrTail)
	}
	if !strings.Contains(loop.Message, "is crash-looping: 3 deaths") {
		t.Fatalf("message = %q", loop.Message)
	}
}

// waitOutboxKind waits (bounded) until the outbox holds n entries of kind.
func waitOutboxKind[T any](t *testing.T, dir, kind string, n int) []outboxEntryOf[T] {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var of []outboxEntryOf[T]
		for _, e := range readOutbox[json.RawMessage](t, dir) {
			if e.Kind != kind {
				continue
			}
			var d T
			if err := json.Unmarshal(e.Data, &d); err != nil {
				t.Fatal(err)
			}
			of = append(of, outboxEntryOf[T]{Kind: e.Kind, Message: e.Message, Data: d})
		}
		if len(of) >= n {
			return of
		}
		if time.Now().After(deadline) {
			t.Fatalf("outbox holds %d %s entries, want %d", len(of), kind, n)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
