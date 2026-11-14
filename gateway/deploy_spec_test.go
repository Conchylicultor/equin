package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// postRestart POSTs the restart route for alpha, with body (nil: no body).
func postRestart(p *Proxy, body []byte) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "http://alpha.localhost:9000/gateway/worktrees/alpha/restart", bytes.NewReader(body))
	req.Host = "alpha.localhost:9000"
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)
	return rec
}

// restartBody is {"spec": spec} as the route takes it.
func restartBody(t *testing.T, spec map[string]any) []byte {
	t.Helper()
	b, err := json.Marshal(map[string]any{"spec": spec})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// newWebDir is a dist whose shell says marker.
func newWebDir(t *testing.T, marker string) string {
	t.Helper()
	web := t.TempDir()
	if err := os.WriteFile(filepath.Join(web, "index.html"), []byte("<html>"+marker+"</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	return web
}

func readSpecFile(t *testing.T, pf priorityFixture) []byte {
	t.Helper()
	b, err := os.ReadFile(specFilePath(pf.regDir, "alpha"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// helperCommand is the fixture's helper backend argv plus extra args.
func helperCommand(pf priorityFixture, extra ...string) []string {
	return append([]string{os.Args[0], "-test.run=^TestHelperBackend$", "--", "spawns=" + pf.spawns}, extra...)
}

// A restart carrying its spec boots the candidate while the old backend and
// the old web keep serving, and commits it — in memory and in spec.json — only
// once the candidate's backend is ready.
func TestRestartBodyCommitsCandidateOnceReady(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	ctx := context.Background()
	if _, err := pf.wt.Ensure(ctx, StartDeploy, "test"); err != nil {
		t.Fatal(err)
	}
	before := pf.wt.Spec()
	diskBefore := readSpecFile(t, pf)

	gate := filepath.Join(t.TempDir(), "g2")
	newWeb := newWebDir(t, "new-shell")
	body := restartBody(t, map[string]any{
		"server":  before.Server,
		"web":     newWeb,
		"command": helperCommand(pf, "gate="+gate),
		"future":  "a field this gateway does not know",
	})
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- postRestart(pf.proxy, body) }()
	waitFor(t, "the candidate to spawn", func() bool { return pf.spawnCount() == 2 })

	// Booting, not ready: nothing of the candidate is visible yet.
	if got := serve(pf.proxy, "alpha.localhost:9000", "/").Body.String(); !strings.Contains(got, "spa-shell") {
		t.Fatalf("shell while the candidate boots = %q, want the old one", got)
	}
	if pf.wt.Spec() != before {
		t.Fatal("the candidate became the spec before its backend was ready")
	}
	if !bytes.Equal(readSpecFile(t, pf), diskBefore) {
		t.Fatal("spec.json was rewritten before the candidate's backend was ready")
	}

	mustTouch(t, gate)
	rec := <-done
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"restarted":true}` {
		t.Fatalf("restart = %d %q", rec.Code, rec.Body.String())
	}
	if got := serve(pf.proxy, "alpha.localhost:9000", "/").Body.String(); !strings.Contains(got, "new-shell") {
		t.Fatalf("shell after the restart = %q, want the candidate's", got)
	}
	if got := pf.wt.Spec().Web; got != newWeb {
		t.Fatalf("web = %q, want %q", got, newWeb)
	}
	disk := readSpecFile(t, pf)
	onDisk, err := parseSpec(disk)
	if err != nil {
		t.Fatal(err)
	}
	if onDisk.Web != newWeb {
		t.Fatalf("spec.json web = %q, want %q", onDisk.Web, newWeb)
	}
	if !strings.Contains(string(disk), `"future"`) {
		t.Fatalf("spec.json dropped a field the gateway does not know: %s", disk)
	}
	// The committed spec carries the written file's revision: no re-adoption.
	committed := pf.wt.Spec()
	pf.reg.RefreshSpec("alpha")
	pf.reg.reconcileOnce()
	if pf.wt.Spec() != committed {
		t.Fatal("RefreshSpec re-adopted the file the commit wrote")
	}
	entries, _ := os.ReadDir(filepath.Join(pf.regDir, "alpha"))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}
}

// A candidate that fails to boot changes nothing: the old backend serves, and
// the spec stays what it was, in memory and on disk.
func TestRestartBodyFailedBootLeavesSpecAndBackend(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	ctx := context.Background()
	old, err := pf.wt.Ensure(ctx, StartDeploy, "test")
	if err != nil {
		t.Fatal(err)
	}
	before := pf.wt.Spec()
	diskBefore := readSpecFile(t, pf)

	rec := postRestart(pf.proxy, restartBody(t, map[string]any{
		"server":  before.Server,
		"web":     newWebDir(t, "new-shell"),
		"command": helperCommand(pf, "crash"),
	}))
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "old backend intact") {
		t.Fatalf("restart = %d %q, want 500 naming the intact old backend", rec.Code, rec.Body.String())
	}
	if pf.wt.Spec() != before {
		t.Fatal("a failed candidate replaced the spec in memory")
	}
	if !bytes.Equal(readSpecFile(t, pf), diskBefore) {
		t.Fatal("a failed candidate rewrote spec.json")
	}
	if bk, err := pf.wt.Ensure(ctx, StartBackground, "test"); err != nil || bk != old {
		t.Fatalf("after the failed restart: %v, %v; want the old backend serving", bk, err)
	}
	if got := serve(pf.proxy, "alpha.localhost:9000", "/").Body.String(); !strings.Contains(got, "spa-shell") {
		t.Fatalf("shell after the failed restart = %q, want the old one", got)
	}
}

// A candidate's env reaches the backend it spawns, over the declared child
// env (a same-named entry replaced) — here on the cold path, which commits too.
func TestRestartBodyEnvReachesBackend(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	envout := filepath.Join(t.TempDir(), "env")
	newWeb := newWebDir(t, "new-shell")
	rec := postRestart(pf.proxy, restartBody(t, map[string]any{
		"server":  pf.wt.Spec().Server,
		"web":     newWeb,
		"command": helperCommand(pf, "envout="+envout),
		"env":     map[string]string{"EQUIN_TEST_SPEC_ENV": "from-spec", "HOME": "/from-spec-home"},
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("restart = %d %q", rec.Code, rec.Body.String())
	}
	got, err := os.ReadFile(envout)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(got), "\n")
	has := func(kv string) bool {
		for _, l := range lines {
			if l == kv {
				return true
			}
		}
		return false
	}
	if !has("EQUIN_TEST_SPEC_ENV=from-spec") || !has("HOME=/from-spec-home") {
		t.Fatalf("backend env lacks the spec's entries:\n%s", got)
	}
	if n := strings.Count(string(got), "\nHOME=") + boolInt(strings.HasPrefix(string(got), "HOME=")); n != 1 {
		t.Fatalf("HOME appears %d times, want once (the spec's replaces the declared one)", n)
	}
	if !has("PATH=" + os.Getenv("PATH")) {
		t.Fatal("the declared child env is missing")
	}
	if pf.wt.Spec().Web != newWeb || pf.wt.Spec().Env["EQUIN_TEST_SPEC_ENV"] != "from-spec" {
		t.Fatal("the cold-started candidate was not committed in memory")
	}
	if onDisk, err := parseSpec(readSpecFile(t, pf)); err != nil || onDisk.Env["EQUIN_TEST_SPEC_ENV"] != "from-spec" {
		t.Fatalf("spec.json env not committed: %v", err)
	}
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// An invalid candidate is refused before anything spawns.
func TestRestartBodyRejectsInvalidSpec(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	before := pf.wt.Spec()
	diskBefore := readSpecFile(t, pf)
	for name, spec := range map[string]map[string]any{
		"env key with =":  {"server": before.Server, "env": map[string]string{"A=B": "x"}},
		"empty env key":   {"server": before.Server, "env": map[string]string{"": "x"}},
		"relative server": {"server": "rel/server"},
		"missing server":  {"server": filepath.Join(t.TempDir(), "gone")},
	} {
		rec := postRestart(pf.proxy, restartBody(t, spec))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: restart = %d %q, want 400", name, rec.Code, rec.Body.String())
		}
	}
	for _, body := range []string{`{"spec":null}`, `{"other":{}}`, `not json`} {
		if rec := postRestart(pf.proxy, []byte(body)); rec.Code != http.StatusBadRequest {
			t.Fatalf("body %s: restart = %d, want 400", body, rec.Code)
		}
	}
	if pf.spawnCount() != 0 {
		t.Fatal("an invalid candidate spawned a backend")
	}
	if pf.wt.Spec() != before || !bytes.Equal(readSpecFile(t, pf), diskBefore) {
		t.Fatal("an invalid candidate changed the spec")
	}
}

// A spec.json with an invalid env key is refused like any invalid spec.
func TestLoadSpecRejectsInvalidEnvKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "spec.json")
	if err := os.WriteFile(path, []byte(`{"server":"/s","env":{"A=B":"x"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadSpec(path); err == nil {
		t.Fatal("loadSpec accepted an env key holding `=`")
	}
}

// No body: today's form — the build rewrote spec.json, the route adopts it
// (RefreshSpec) and boots it.
func TestRestartWithoutBodyAdoptsTheFile(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	newWeb := newWebDir(t, "new-shell")
	b, err := json.Marshal(map[string]any{
		"server":  pf.wt.Spec().Server,
		"web":     newWeb,
		"command": helperCommand(pf),
	})
	if err != nil {
		t.Fatal(err)
	}
	writeSpecAtomic(t, specFilePath(pf.regDir, "alpha"), string(b))
	rec := postRestart(pf.proxy, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("restart = %d %q", rec.Code, rec.Body.String())
	}
	if pf.wt.Spec().Web != newWeb {
		t.Fatalf("web = %q, want the rewritten file's", pf.wt.Spec().Web)
	}
	if pf.spawnCount() != 1 {
		t.Fatalf("spawns = %d, want 1", pf.spawnCount())
	}
}
