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
	"syscall"
	"testing"
	"time"
	"unicode/utf8"
)

// The entry the writer builds is byte-for-byte the shape the TypeScript side
// reads: testdata/backend-crash-entry.json is parsed by the backend-crash
// kind's own test with the outbox envelope schema and the kind's payload
// schema (plugins/debug/plugins/backend-crash/core/kind.test.ts). Change one
// side and the other's test fails.
func TestBackendCrashEntryMatchesTheGolden(t *testing.T) {
	crash := newBackendCrash("alpha", 45958, syscall.SIGSEGV, false,
		1794150000000, 1794153877965, "equin · server · alpha",
		[]string{
			"Bun v1.4.4 (38afee6c8) macOS Silicon",
			"panic: Segmentation fault at address 0x7BC138",
			"oh no: Bun has crashed. This indicates a bug in Bun, not your code.",
			" https://bun.report/1.4.4/Ma138afee6i3FuhooC__________A2AwzgvP",
		}, true)
	got, err := json.Marshal(newOutboxEntry(crash, 1234, "/repo/plugins/framework/plugins/server-core"))
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile(filepath.Join("testdata", "backend-crash-entry.json"))
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
		t.Fatalf("entry drifted from testdata/backend-crash-entry.json:\n got %s", got)
	}
}

func TestCrashMessageNamesTheSignalUptimeAndPanic(t *testing.T) {
	c := newBackendCrash("main", 1, syscall.SIGSEGV, false, 0, 65*60*1000, "bun",
		[]string{"x", "panic: Segmentation fault at address 0x28", "y"}, true)
	if got, want := crashMessage(c), "backend main died by SIGSEGV after 1h5m0s — panic: Segmentation fault at address 0x28"; got != want {
		t.Fatalf("message = %q, want %q", got, want)
	}
	c.StderrTail = nil
	if got := crashMessage(c); got != "backend main died by SIGSEGV after 1h5m0s" {
		t.Fatalf("message without a panic line = %q", got)
	}
}

func TestWriteOutboxEntryRenamesIntoPlaceAndRefusesWhenFull(t *testing.T) {
	dir := t.TempDir()
	e := newOutboxEntry(newBackendCrash("a", 1, syscall.SIGBUS, false, 0, 1, "bun", nil, true), 2, "/x")
	path, err := writeOutboxEntry(dir, e, time.UnixMilli(1794153877965))
	if err != nil {
		t.Fatal(err)
	}
	if !outboxEntryName.MatchString(filepath.Base(path)) || !strings.HasPrefix(filepath.Base(path), "1794153877965-") {
		t.Fatalf("entry name %q is not the drain's pattern", filepath.Base(path))
	}
	names, _ := os.ReadDir(dir)
	if len(names) != 1 {
		t.Fatalf("dir holds %d files, want only the entry (no temp left behind)", len(names))
	}
	body, _ := os.ReadFile(path)
	if !strings.Contains(string(body), `"stderrTail":[]`) {
		t.Fatalf("an empty tail must be an array, not null: %s", body)
	}

	for i := 1; i < outboxMaxPending; i++ {
		mustTouch(t, filepath.Join(dir, fmt.Sprintf("%d-1-a.json", i)))
	}
	if _, err := writeOutboxEntry(dir, e, time.Now()); err == nil || !strings.Contains(err.Error(), "cap 1000") {
		t.Fatalf("full outbox: err = %v, want a refusal naming the cap", err)
	}
}

func TestLineTailKeepsTheLastLinesAndCutsLongOnes(t *testing.T) {
	tail := newLineTail(3)
	for _, l := range []string{"a", "b", "c", "d"} {
		tail.add(l)
	}
	if got := tail.lines(); !reflect.DeepEqual(got, []string{"b", "c", "d"}) {
		t.Fatalf("tail = %q", got)
	}
	long := strings.Repeat("é", crashLineMaxBytes) // 2 bytes each
	tail.add(long)
	got := tail.lines()[2]
	if len(got) > crashLineMaxBytes+len(lineCutSuffix) || !strings.HasSuffix(got, lineCutSuffix) || !utf8.ValidString(got) {
		t.Fatalf("cut line: %d bytes, valid %v, suffix %v", len(got), utf8.ValidString(got), strings.HasSuffix(got, lineCutSuffix))
	}
}

// outboxEntries reads every complete entry in dir.
// outboxEntryOf is an outbox entry read back with its payload as kind T.
type outboxEntryOf[T any] struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Data    T      `json:"data"`
}

func outboxEntries(t *testing.T, dir string) []outboxEntryOf[backendCrash] {
	return readOutbox[backendCrash](t, dir)
}

func readOutbox[T any](t *testing.T, dir string) []outboxEntryOf[T] {
	t.Helper()
	names, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var out []outboxEntryOf[T]
	for _, n := range names {
		if !outboxEntryName.MatchString(n.Name()) {
			continue
		}
		body, err := os.ReadFile(filepath.Join(dir, n.Name()))
		if err != nil {
			t.Fatal(err)
		}
		var e outboxEntryOf[T]
		if err := json.Unmarshal(body, &e); err != nil {
			t.Fatal(err)
		}
		out = append(out, e)
	}
	return out
}

// A backend that dies by a signal nobody in the gateway sent — here a shell
// that prints a Bun-style panic and SIGSEGVs itself mid-boot — is filed in
// the outbox with that signal and its last stderr, the panic line included.
func TestBackendKilledBySignalIsReported(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	outbox := t.TempDir()
	pf.wt.cfg.ReportOutboxDir = outbox
	spec := *pf.wt.Spec()
	spec.Command = []string{"/bin/sh", "-c",
		`echo "before the fault" >&2; echo "panic: Segmentation fault at address 0x28" >&2; kill -SEGV $$`}
	pf.wt.UpdateSpec(&spec)

	if _, err := pf.wt.Ensure(context.Background(), StartBackground, "test"); !errors.Is(err, ErrSpawnFailed) {
		t.Fatalf("Ensure: err = %v, want ErrSpawnFailed", err)
	}
	var entries []outboxEntryOf[backendCrash]
	deadline := time.Now().Add(5 * time.Second)
	for len(entries) == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
		entries = outboxEntries(t, outbox)
	}
	if len(entries) != 1 {
		t.Fatalf("outbox holds %d entries, want 1", len(entries))
	}
	e := entries[0]
	if e.Kind != backendCrashKind || e.Data.Worktree != "alpha" || e.Data.Signal != "SIGSEGV" || e.Data.SignalNumber != int(syscall.SIGSEGV) {
		t.Fatalf("entry = %+v", e)
	}
	if !e.Data.StderrComplete || !reflect.DeepEqual(e.Data.StderrTail,
		[]string{"before the fault", "panic: Segmentation fault at address 0x28"}) {
		t.Fatalf("stderr tail = %q (complete %v)", e.Data.StderrTail, e.Data.StderrComplete)
	}
	if e.Data.Executable != "sh" || e.Data.Pid <= 0 || e.Data.ExitedAt < e.Data.StartedAt {
		t.Fatalf("process facts = %+v", e.Data)
	}
	if !strings.Contains(e.Message, "died by SIGSEGV") || !strings.Contains(e.Message, "panic: Segmentation fault") {
		t.Fatalf("message = %q", e.Message)
	}
}

// The gateway's own kills are not crashes: a boot SIGKILLed at its readiness
// deadline, and a running backend stopped (SIGTERM, which the helper dies of).
func TestGatewaySentSignalsAreNotReported(t *testing.T) {
	t.Run("readiness kill", func(t *testing.T) {
		pf := newPriorityFixture(t, "alpha", true) // gated: never ready
		outbox := t.TempDir()
		pf.wt.cfg.ReportOutboxDir = outbox
		pf.wt.cfg.ReadyTimeout = 200 * time.Millisecond
		pf.wt.cfg.ReadyTimeoutMax = 200 * time.Millisecond
		if _, err := pf.wt.Ensure(context.Background(), StartBrowser, "test"); !errors.Is(err, ErrSpawnFailed) {
			t.Fatalf("Ensure: err = %v, want ErrSpawnFailed (killed at its deadline)", err)
		}
		time.Sleep(crashStderrGrace + 200*time.Millisecond)
		if n := len(outboxEntries(t, outbox)); n != 0 {
			t.Fatalf("outbox holds %d entries, want none for the gateway's own kill", n)
		}
	})
	t.Run("stop", func(t *testing.T) {
		pf := newPriorityFixture(t, "alpha", false)
		outbox := t.TempDir()
		pf.wt.cfg.ReportOutboxDir = outbox
		if _, err := pf.wt.Ensure(context.Background(), StartBrowser, "test"); err != nil {
			t.Fatal(err)
		}
		if err := pf.wt.Stop(context.Background()); err != nil {
			t.Fatal(err)
		}
		time.Sleep(crashStderrGrace + 200*time.Millisecond)
		if n := len(outboxEntries(t, outbox)); n != 0 {
			t.Fatalf("outbox holds %d entries, want none for a stop", n)
		}
	})
}
