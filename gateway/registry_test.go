package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newTestRegistry builds a Registry rooted at fresh temp dirs. LogBufferLines is
// nonzero so NewWorktree's log ring is valid; the rotating log writer opens lazily
// so no FD is held by merely registering a worktree.
func newTestRegistry(t *testing.T) (*Registry, string) {
	t.Helper()
	regDir := t.TempDir()
	// SocketsDir must be short: NewWorktree rejects worktrees whose <name>.next.sock
	// path exceeds 104 bytes, and the default macOS $TMPDIR ($t.TempDir) is far too
	// long. Use a short /tmp dir, matching sockets_test.go.
	sockDir, err := os.MkdirTemp("/tmp", "gwreg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(sockDir) })
	cfg := &Config{
		RegistryDir:    regDir,
		SocketsDir:     sockDir,
		LogDir:         t.TempDir(),
		LogBufferLines: 16,
		ChildEnv:       testChildEnv(t),
	}
	return NewRegistry(cfg), regDir
}

// writeSpec writes a <regDir>/<name>/spec.json with an absolute server path
// (loadSpec requires server to be absolute) and creates that server dir on disk —
// loadFile rejects a spec whose backing server dir is missing (serverPathMissing),
// so the fixture must materialize it for the worktree to register.
func writeSpec(t *testing.T, regDir, name string) {
	t.Helper()
	sub := filepath.Join(regDir, name)
	server := filepath.Join(sub, "server")
	if err := os.MkdirAll(server, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"server":"` + server + `"}`
	if err := os.WriteFile(filepath.Join(sub, "spec.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// rewriteSpec replaces an existing <regDir>/<name>/spec.json with one naming
// `web`, using the same atomic temp+rename the build's writer uses — so the
// tests exercise the exact write shape the change-detection is designed around
// (new inode, directory entry swapped in one step).
func rewriteSpec(t *testing.T, regDir, name, web string) {
	t.Helper()
	sub := filepath.Join(regDir, name)
	body := `{"server":"` + filepath.Join(sub, "server") + `","web":"` + web + `"}`
	writeSpecAtomic(t, filepath.Join(sub, "spec.json"), body)
}

func writeSpecAtomic(t *testing.T, specPath, body string) {
	t.Helper()
	tmp := specPath + ".tmp"
	if err := os.WriteFile(tmp, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, specPath); err != nil {
		t.Fatal(err)
	}
}

// A registered worktree must adopt a rewritten spec.json — the defect this
// mechanism exists to fix. Before it, reconcile skipped every already-known
// name outright, so `web` was frozen for the gateway process's lifetime and a
// build that repointed the dist was invisible.
func TestReconcileAdoptsRewrittenSpec(t *testing.T) {
	reg, regDir := newTestRegistry(t)
	writeSpec(t, regDir, "alpha")
	reg.reconcileOnce()

	wt := reg.Get("alpha")
	if wt == nil {
		t.Fatal("alpha should be registered")
	}
	if got := wt.Spec().Web; got != "" {
		t.Fatalf("initial web = %q, want empty", got)
	}

	rewriteSpec(t, regDir, "alpha", "/new/dist")
	reg.reconcileOnce()

	if reg.Get("alpha") != wt {
		t.Fatal("a spec rewrite must update the worktree in place, not re-register it")
	}
	if got := wt.Spec().Web; got != "/new/dist" {
		t.Fatalf("web after rewrite = %q, want /new/dist", got)
	}
}

// An unchanged spec.json must produce no update at all. Asserted on pointer
// identity of the stored *Spec: a re-store would swap the pointer even though
// the parsed contents match, and that is exactly the churn (plus a log line per
// tick per worktree) the revision check exists to prevent.
func TestReconcileDoesNotChurnUnchangedSpec(t *testing.T) {
	reg, regDir := newTestRegistry(t)
	writeSpec(t, regDir, "alpha")
	reg.reconcileOnce()

	wt := reg.Get("alpha")
	first := wt.Spec()
	for i := 0; i < 3; i++ {
		reg.reconcileOnce()
	}
	if wt.Spec() != first {
		t.Fatal("an unchanged spec.json must not replace the in-memory spec")
	}

	// Nor may an unconditional load path (Watch/LoadAll/Resolve all call
	// loadFile directly) churn it: the no-op is an invariant of upsert, not
	// something each caller has to remember.
	reg.loadFile(filepath.Join(regDir, "alpha", "spec.json"))
	if wt.Spec() != first {
		t.Fatal("an unconditional loadFile of an unchanged spec must not replace it")
	}
}

// A rewrite that is byte-identical in mtime AND size must still be adopted.
// This is the coarse-mtime-filesystem case: the fixture forces the new file's
// mtime back to the old one, leaving the inode (swapped by the rename) as the
// only signal. If detection were keyed on mtime+size alone this test fails.
func TestReconcileAdoptsSameMtimeSameSizeRewrite(t *testing.T) {
	reg, regDir := newTestRegistry(t)
	writeSpec(t, regDir, "alpha")
	specPath := filepath.Join(regDir, "alpha", "spec.json")
	server := filepath.Join(regDir, "alpha", "server")

	// Two bodies of identical length differing only in the web path.
	rewriteSpec(t, regDir, "alpha", "/dist/aaa")
	reg.reconcileOnce()
	wt := reg.Get("alpha")
	if wt == nil || wt.Spec().Web != "/dist/aaa" {
		t.Fatalf("setup: web = %v", wt)
	}
	before, err := os.Stat(specPath)
	if err != nil {
		t.Fatal(err)
	}

	writeSpecAtomic(t, specPath, `{"server":"`+server+`","web":"/dist/bbb"}`)
	if err := os.Chtimes(specPath, before.ModTime(), before.ModTime()); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(specPath)
	if err != nil {
		t.Fatal(err)
	}
	if after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		t.Fatalf("fixture must produce an identical (mtime,size): before=(%v,%d) after=(%v,%d)",
			before.ModTime(), before.Size(), after.ModTime(), after.Size())
	}

	reg.reconcileOnce()
	if got := wt.Spec().Web; got != "/dist/bbb" {
		t.Fatalf("web = %q, want /dist/bbb — a same-mtime same-size rewrite was missed", got)
	}
}

// A malformed spec.json must leave the previously loaded spec live and must not
// evict the worktree. Adopting a half-written or corrupt file, or dropping the
// worktree over one, would both take a serving namespace down for a fault that
// costs nothing to ignore.
func TestReconcileMalformedSpecKeepsPreviousAndDoesNotEvict(t *testing.T) {
	reg, regDir := newTestRegistry(t)
	writeSpec(t, regDir, "alpha")
	rewriteSpec(t, regDir, "alpha", "/good/dist")
	reg.reconcileOnce()
	wt := reg.Get("alpha")
	if wt == nil || wt.Spec().Web != "/good/dist" {
		t.Fatalf("setup failed: %v", wt)
	}

	specPath := filepath.Join(regDir, "alpha", "spec.json")

	// (a) unparseable JSON — a truncated write.
	if err := os.WriteFile(specPath, []byte(`{"server":`), 0o644); err != nil {
		t.Fatal(err)
	}
	reg.reconcileOnce()
	reg.reconcileOnce() // repeated ticks must not degrade into an eviction
	if reg.Get("alpha") != wt {
		t.Fatal("a malformed spec must not evict the worktree")
	}
	if got := wt.Spec().Web; got != "/good/dist" {
		t.Fatalf("web = %q, want the previously loaded /good/dist", got)
	}

	// (b) schema-invalid — parses, but violates loadSpec's contract.
	if err := os.WriteFile(specPath, []byte(`{"server":"relative/path"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	reg.reconcileOnce()
	if reg.Get("alpha") != wt || wt.Spec().Web != "/good/dist" {
		t.Fatal("a schema-invalid spec must leave the previous spec live")
	}

	// (c) spec.json momentarily absent — the non-atomic-rewrite window the
	// dir-presence keying was designed for. Still no eviction.
	if err := os.Remove(specPath); err != nil {
		t.Fatal(err)
	}
	reg.reconcileOnce()
	if reg.Get("alpha") != wt || wt.Spec().Web != "/good/dist" {
		t.Fatal("a transiently absent spec must neither evict nor change the spec")
	}

	// (d) recovery: a valid rewrite after all that is adopted normally.
	rewriteSpec(t, regDir, "alpha", "/recovered/dist")
	reg.reconcileOnce()
	if got := wt.Spec().Web; got != "/recovered/dist" {
		t.Fatalf("web = %q, want /recovered/dist after recovery", got)
	}
}

// A spec rewrite that repoints `server` at a path that does not exist must not
// be adopted, and must not evict: the worktree keeps serving on its old spec
// rather than becoming permanently unspawnable.
func TestReconcileRejectsRewriteToMissingServerDir(t *testing.T) {
	reg, regDir := newTestRegistry(t)
	writeSpec(t, regDir, "alpha")
	rewriteSpec(t, regDir, "alpha", "/good/dist")
	reg.reconcileOnce()
	wt := reg.Get("alpha")

	specPath := filepath.Join(regDir, "alpha", "spec.json")
	writeSpecAtomic(t, specPath, `{"server":"/nonexistent/server/dir","web":"/other/dist"}`)
	reg.reconcileOnce()

	if reg.Get("alpha") != wt {
		t.Fatal("a rewrite naming a missing server dir must not evict the worktree")
	}
	if got := wt.Spec().Server; got != filepath.Join(regDir, "alpha", "server") {
		t.Fatalf("server = %q, want the previously loaded one", got)
	}
	if got := wt.Spec().Web; got != "/good/dist" {
		t.Fatalf("web = %q, want /good/dist", got)
	}
}

// RefreshSpec is the on-demand form used by the restart route, so a build does
// not have to race the reconcile tick.
func TestRefreshSpecAdoptsRewriteOnDemand(t *testing.T) {
	reg, regDir := newTestRegistry(t)
	writeSpec(t, regDir, "alpha")
	reg.reconcileOnce()
	wt := reg.Get("alpha")
	first := wt.Spec()

	rewriteSpec(t, regDir, "alpha", "/fresh/dist")
	reg.RefreshSpec("alpha")
	if got := wt.Spec().Web; got != "/fresh/dist" {
		t.Fatalf("web = %q, want /fresh/dist", got)
	}

	// Idempotent, and silent on an unknown or invalid name.
	current := wt.Spec()
	reg.RefreshSpec("alpha")
	if wt.Spec() != current {
		t.Fatal("RefreshSpec of an unchanged spec must not churn")
	}
	reg.RefreshSpec("ghost")
	reg.RefreshSpec("Bad_Name")
	if first == current {
		t.Fatal("sanity: the rewrite should have replaced the spec pointer")
	}
}

// Resolve must load a worktree from disk on demand when its spec.json exists but
// the in-memory registry never saw a create event — the exact FD-pressure case.
func TestResolveLoadsSpecFromDisk(t *testing.T) {
	reg, regDir := newTestRegistry(t)
	writeSpec(t, regDir, "alpha")

	if reg.Get("alpha") != nil {
		t.Fatal("alpha should not be registered before Resolve")
	}
	if wt := reg.Resolve("alpha"); wt == nil {
		t.Fatal("Resolve should load alpha from disk")
	}
	if reg.Get("alpha") == nil {
		t.Fatal("Resolve should have registered alpha in-memory")
	}
	// A name with no spec on disk, and an invalid name, both resolve to nil.
	if reg.Resolve("ghost") != nil {
		t.Fatal("Resolve of a missing spec should be nil")
	}
	if reg.Resolve("Bad_Name") != nil {
		t.Fatal("Resolve of an invalid name should be nil")
	}
}

// reconcileOnce must register specs the watch missed and unregister worktrees
// whose backing dir vanished.
func TestReconcileRegistersAndUnregisters(t *testing.T) {
	reg, regDir := newTestRegistry(t)
	writeSpec(t, regDir, "alpha")
	writeSpec(t, regDir, "beta")

	reg.reconcileOnce()
	if reg.Get("alpha") == nil || reg.Get("beta") == nil {
		t.Fatal("reconcile should register both on-disk worktrees")
	}

	// Remove beta's dir; reconcile should drop it (worktree-cleanup case).
	if err := os.RemoveAll(filepath.Join(regDir, "beta")); err != nil {
		t.Fatal(err)
	}
	reg.reconcileOnce()
	if reg.Get("alpha") == nil {
		t.Fatal("reconcile must keep alpha (dir still present)")
	}
	if reg.Get("beta") != nil {
		t.Fatal("reconcile must unregister beta after its dir was removed")
	}
}

// reconcileOnce must ignore flat .json files that share the registry dir — stray
// build-profile/build-logs profiling artifacts and leftover flat legacy specs.
// The legacy flat-spec layout was retired: only <name>/spec.json subdirs are
// worktrees. Re-parsing these flat files as specs every tick is what produced the
// "failed to load legacy spec" warn-flood this guards against.
func TestReconcileIgnoresFlatJSON(t *testing.T) {
	reg, regDir := newTestRegistry(t)
	writeSpec(t, regDir, "alpha")

	// A non-spec profiling artifact: parses as JSON but has no server field.
	if err := os.WriteFile(
		filepath.Join(regDir, "att-123-build-profile.json"),
		[]byte(`{"spans":[],"totalDurationMs":0}`), 0o644,
	); err != nil {
		t.Fatal(err)
	}
	// A *valid* flat legacy spec with an existing server dir — under the old
	// behavior this would have registered "legacy"; after retirement it must not.
	legacyServer := filepath.Join(regDir, "legacy-server")
	if err := os.MkdirAll(legacyServer, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(regDir, "legacy.json"),
		[]byte(`{"server":"`+legacyServer+`"}`), 0o644,
	); err != nil {
		t.Fatal(err)
	}

	reg.reconcileOnce()

	if reg.Get("alpha") == nil {
		t.Fatal("reconcile must still register the subdir worktree alpha")
	}
	if reg.Get("att-123-build-profile") != nil {
		t.Fatal("a flat build-profile artifact must never register as a worktree")
	}
	if reg.Get("legacy") != nil {
		t.Fatal("a flat legacy spec must no longer register (legacy scan retired)")
	}
}

// A multi-label namespace must load from disk exactly like a flat one — the dir
// name is the key, dots and all, and the gateway never decomposes it.
func TestResolveLoadsMultiLabelSpecFromDisk(t *testing.T) {
	reg, regDir := newTestRegistry(t)
	writeSpec(t, regDir, "sonata.att-x")
	if wt := reg.Get("sonata.att-x"); wt != nil {
		t.Fatal("expected no in-memory registration before Resolve")
	}
	wt := reg.Resolve("sonata.att-x")
	if wt == nil {
		t.Fatal("Resolve did not load the multi-label spec from disk")
	}
	if wt.Name != "sonata.att-x" {
		t.Fatalf("worktree name = %q, want %q", wt.Name, "sonata.att-x")
	}
}

// The per-label grammar exists to keep a dotted name a single safe path segment.
// These are the shapes that would stop being one. Asserted through
// validNamespace, not nameRegex, because validNamespace IS the rule — the regex
// is only half of it.
func TestNameRegexRejectsPathUnsafeNames(t *testing.T) {
	for _, bad := range []string{
		"", "..", ".", "a..b", ".a", "a.", "a/b", "a/../b", "A", "a_b",
		"-a", "a b", "sonata..att-x", "sonata./att-x",
		// 64 bytes: one over the datname cap, so its database would be a
		// different (truncated) name than the one being routed.
		strings.Repeat("a", 32) + "." + strings.Repeat("b", 31),
	} {
		if validNamespace(bad) {
			t.Errorf("validNamespace accepted %q; it must not", bad)
		}
	}
	for _, good := range []string{
		"a", mainNamespace, "att-1787064474-2qcq", "sonata.att-x", "a-1.b-2",
		// Exactly 63 bytes — the longest namespace Postgres stores intact.
		strings.Repeat("a", 31) + "." + strings.Repeat("b", 31),
	} {
		if !validNamespace(good) {
			t.Errorf("validNamespace rejected %q; it must accept it", good)
		}
	}
}
