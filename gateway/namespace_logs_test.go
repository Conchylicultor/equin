package main

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

func touch(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func listDir(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	return names
}

func TestSweepOrphanNamespaceLogs(t *testing.T) {
	logDir, registryDir := t.TempDir(), t.TempDir()
	for _, live := range []string{"central", "att-1", "web.att-1"} {
		if err := os.MkdirAll(filepath.Join(registryDir, live), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{
		"gateway.log", "gateway.log.1", "gateway-stdio.log", // the gateway's own
		"central.log", "att-1.log", "att-1.log.3", "web.att-1.log", // live namespaces
		"att-2.log", "att-2.log.1", "web.att-2.log", // reaped
		"att-10.log",            // reaped; shares a prefix with nothing live
		"notes.txt",             // not a channel
		"services/postgres.log", // a service channel, in its subdir
	} {
		touch(t, filepath.Join(logDir, f))
	}
	sweepOrphanNamespaceLogs(logDir, registryDir)
	want := []string{"att-1.log", "att-1.log.3", "central.log", "gateway-stdio.log",
		"gateway.log", "gateway.log.1", "notes.txt", "services", "web.att-1.log"}
	if got := listDir(t, logDir); !equalStrings(got, want) {
		t.Fatalf("left %v, want %v", got, want)
	}
	if _, err := os.Stat(filepath.Join(logDir, "services", "postgres.log")); err != nil {
		t.Fatalf("service log removed: %v", err)
	}
}

func TestRemoveNamespaceLogsKeepsPrefixSiblings(t *testing.T) {
	logDir := t.TempDir()
	for _, f := range []string{"att-1.log", "att-1.log.2", "att-10.log", "att-1.logx"} {
		touch(t, filepath.Join(logDir, f))
	}
	removeNamespaceLogs(logDir, "att-1")
	want := []string{"att-1.logx", "att-10.log"}
	if got := listDir(t, logDir); !equalStrings(got, want) {
		t.Fatalf("left %v, want %v", got, want)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Reconcile unregistering a namespace whose registry dir is gone deletes its
// logs; one evicted only because its server dir vanished keeps them.
func TestUnregisterDeletesLogsOnlyWhenRegistryDirGone(t *testing.T) {
	reg, regDir := newTestRegistry(t)
	logDir := reg.cfg.LogDir
	writeSpec(t, regDir, "reaped")
	writeSpec(t, regDir, "serverless")
	reg.reconcileOnce()
	touch(t, filepath.Join(logDir, "reaped.log"))
	touch(t, filepath.Join(logDir, "serverless.log"))

	if err := os.RemoveAll(filepath.Join(regDir, "reaped")); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(regDir, "serverless", "server")); err != nil {
		t.Fatal(err)
	}
	reg.reconcileOnce()

	waitGone := func(path string) {
		for i := 0; i < 250; i++ {
			if _, err := os.Stat(path); os.IsNotExist(err) {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("%s not removed", path)
	}
	waitGone(filepath.Join(logDir, "reaped.log"))
	if _, err := os.Stat(filepath.Join(logDir, "serverless.log")); err != nil {
		t.Fatalf("serverless.log removed: %v", err)
	}
}
