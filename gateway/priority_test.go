package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestHelperBackend is not a test: it is the backend the priority tests spawn,
// by re-executing this test binary (argv: -test.run=^TestHelperBackend$ --
// [spawns=F] [gate=F] --namespace N --socket S). It records its start in the
// spawns file, binds the socket, answers 503 until the gate file exists (no
// gate: ready at once) and 200 to everything after. Run directly, it has no
// --socket and returns.
func TestHelperBackend(t *testing.T) {
	var socket, spawns, gate string
	args := os.Args
	for i, a := range args {
		switch {
		case a == "--socket" && i+1 < len(args):
			socket = args[i+1]
		case strings.HasPrefix(a, "spawns="):
			spawns = strings.TrimPrefix(a, "spawns=")
		case strings.HasPrefix(a, "gate="):
			gate = strings.TrimPrefix(a, "gate=")
		}
	}
	if socket == "" {
		return
	}
	if spawns != "" {
		f, err := os.OpenFile(spawns, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			os.Exit(2)
		}
		fmt.Fprintf(f, "%d\n", os.Getpid())
		_ = f.Close()
	}
	l, err := net.Listen("unix", socket)
	if err != nil {
		os.Exit(2)
	}
	_ = http.Serve(l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if gate != "" {
			if _, err := os.Stat(gate); err != nil {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
		}
		w.WriteHeader(http.StatusOK)
	}))
	os.Exit(0)
}

// priorityFixture is the static-proxy fixture whose worktree spawns the helper
// backend through a fake taskpolicy that logs each call ("-b -- …" for a
// demoted spawn, "-B -p <pid>" for a promote) and execs the target.
type priorityFixture struct {
	staticFixture
	wt      *Worktree
	tpLog   string // the fake taskpolicy's call log
	spawns  string // one line per helper backend started
	gate    string // create to make the backend ready
	cleanup func()
}

func newPriorityFixture(t *testing.T, name string, gated bool) priorityFixture {
	t.Helper()
	fx := newStaticProxyNamed(t, name)
	wt := fx.reg.Resolve(name)
	if wt == nil {
		t.Fatalf("%s should resolve", name)
	}
	dir := t.TempDir()
	pf := priorityFixture{
		staticFixture: fx,
		wt:            wt,
		tpLog:         filepath.Join(dir, "taskpolicy.log"),
		spawns:        filepath.Join(dir, "spawns"),
		gate:          filepath.Join(dir, "gate"),
	}
	tp := filepath.Join(dir, "taskpolicy")
	script := "#!/bin/sh\necho \"$*\" >> " + pf.tpLog + "\nif [ \"$1\" = \"-b\" ]; then shift 2; exec \"$@\"; fi\nexit 0\n"
	if err := os.WriteFile(tp, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	wt.cfg.Taskpolicy = tp
	// Far past waitFor's window, so a slow-boot escalation (which promotes
	// too) can never stand in for the promote a test is waiting on.
	wt.cfg.ReadyTimeout = time.Minute
	wt.cfg.ReadyTimeoutMax = time.Minute
	wt.cfg.ShutdownGrace = time.Second
	wt.cfg.BrokenCooldown = time.Second

	command := []string{os.Args[0], "-test.run=^TestHelperBackend$", "--", "spawns=" + pf.spawns}
	if gated {
		command = append(command, "gate="+pf.gate)
	}
	spec := *wt.Spec()
	spec.Command = command
	wt.UpdateSpec(&spec)
	// Open the gate first: Stop waits out an in-flight spawn, so a test that
	// fails with the gate closed would otherwise hang until readiness times out.
	t.Cleanup(func() {
		_ = os.WriteFile(pf.gate, nil, 0o644)
		_ = wt.Stop(context.Background())
	})
	return pf
}

func (pf priorityFixture) openGate(t *testing.T) {
	t.Helper()
	mustTouch(t, pf.gate)
}

func readLines(path string) []string {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return strings.Fields(strings.ReplaceAll(string(b), " ", "_"))
}

// demotedSpawns / promotes count the fake taskpolicy's two kinds of call.
func (pf priorityFixture) demotedSpawns() int { return countPrefix(readLines(pf.tpLog), "-b_--") }
func (pf priorityFixture) promotes() int      { return countPrefix(readLines(pf.tpLog), "-B_-p") }
func (pf priorityFixture) spawnCount() int    { return len(readLines(pf.spawns)) }

func countPrefix(lines []string, prefix string) int {
	n := 0
	for _, l := range lines {
		if strings.HasPrefix(l, prefix) {
			n++
		}
	}
	return n
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (pf priorityFixture) state() string { return pf.wt.Snapshot().State }

func get(p *Proxy, host, path string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "http://"+host+path, nil)
	req.Host = host
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)
	return rec
}

var documentLoad = map[string]string{"Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate"}

// A page load serves the shell at once and starts the backend alongside it,
// at default priority.
func TestDocumentLoadStartsBackendUndemoted(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", true)

	rec := get(pf.proxy, "alpha.localhost:9000", "/", documentLoad)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "spa-shell") {
		t.Fatalf("shell: status %d body %q", rec.Code, rec.Body.String())
	}
	// The shell went out while the backend is still booting (gate closed):
	// the start never delays the static response.
	waitFor(t, "the page-load spawn", func() bool { return pf.spawnCount() == 1 })
	if s := pf.state(); s != "starting" {
		t.Fatalf("state = %q, want starting while the gate is closed", s)
	}
	pf.openGate(t)
	waitFor(t, "running", func() bool { return pf.state() == "running" })
	if n := pf.demotedSpawns(); n != 0 {
		t.Fatalf("browser start spawned demoted (%d taskpolicy -b calls)", n)
	}
}

// The SPA fallback (a deep link) is the shell too, and prestarts the same way.
func TestDeepLinkDocumentLoadStartsBackend(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	rec := get(pf.proxy, "alpha.localhost:9000", "/agents/c/123", documentLoad)
	if !strings.Contains(rec.Body.String(), "spa-shell") {
		t.Fatalf("deep link should serve the shell, got %q", rec.Body.String())
	}
	waitFor(t, "running", func() bool { return pf.state() == "running" })
	if pf.demotedSpawns() != 0 {
		t.Fatal("deep-link document start spawned demoted")
	}
}

// A non-browser /api call (an agent's MCP tool, a script) keeps today's
// behavior: demoted spawn, promoted once ready.
func TestNonBrowserAPIStartsDemoted(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	rec := get(pf.proxy, "alpha.localhost:9000", "/api/tasks", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("api: status %d body %q", rec.Code, rec.Body.String())
	}
	if n := pf.demotedSpawns(); n != 1 {
		t.Fatalf("taskpolicy -b calls = %d, want 1", n)
	}
	if n := pf.promotes(); n != 1 {
		t.Fatalf("taskpolicy -B calls = %d, want 1 (post-ready promote)", n)
	}
}

// A WebSocket a page opens (Sec-Fetch-Mode: websocket + Origin) is a browser
// start; driven through a real listener since the proxy hijacks the conn.
func TestBrowserWebSocketStartsUndemoted(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	srv := httptest.NewServer(pf.proxy)
	defer srv.Close()

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/ws/live", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "alpha.localhost:9000"
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Sec-Fetch-Mode", "websocket")
	req.Header.Set("Origin", "http://alpha.localhost:9000")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("ws request: %v", err)
	}
	_ = resp.Body.Close()
	if pf.spawnCount() != 1 {
		t.Fatalf("spawns = %d, want 1", pf.spawnCount())
	}
	if n := pf.demotedSpawns(); n != 0 {
		t.Fatalf("browser WebSocket spawned demoted (%d taskpolicy -b calls)", n)
	}
}

func TestStartReasonOf(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string]string
		want    StartReason
	}{
		{"document navigation", documentLoad, StartBrowser},
		{"page websocket", map[string]string{"Upgrade": "websocket", "Sec-Fetch-Mode": "websocket", "Origin": "http://a.localhost:9000"}, StartBrowser},
		{"websocket without Origin", map[string]string{"Upgrade": "websocket", "Sec-Fetch-Mode": "websocket"}, StartBackground},
		{"websocket without fetch metadata", map[string]string{"Upgrade": "websocket", "Origin": "http://a.localhost:9000"}, StartBackground},
		{"app fetch()", map[string]string{"Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Origin": "http://a.localhost:9000"}, StartBackground},
		{"script / curl", nil, StartBackground},
	}
	for _, c := range cases {
		req := httptest.NewRequest(http.MethodGet, "http://a.localhost:9000/api/x", nil)
		for k, v := range c.headers {
			req.Header.Set(k, v)
		}
		if got := startReasonOf(req); got != c.want {
			t.Errorf("%s: reason = %s, want %s", c.name, got, c.want)
		}
	}
}

// A browser joining an in-flight background spawn promotes it at once — not
// at readiness: the gate stays closed until the promote is observed.
func TestBrowserJoiningBackgroundStartPromotes(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", true)
	ctx := context.Background()

	bgDone := make(chan error, 1)
	go func() { _, err := pf.wt.Ensure(ctx, StartBackground); bgDone <- err }()
	waitFor(t, "the demoted background spawn", func() bool {
		return pf.demotedSpawns() == 1 && pf.spawnCount() == 1
	})
	if pf.promotes() != 0 {
		t.Fatal("background spawn promoted before anyone joined")
	}

	brDone := make(chan error, 1)
	go func() { _, err := pf.wt.Ensure(ctx, StartBrowser); brDone <- err }()
	waitFor(t, "the browser join's promote", func() bool { return pf.promotes() == 1 })
	if s := pf.state(); s != "starting" {
		t.Fatalf("state = %q, want starting (promote must precede readiness)", s)
	}

	pf.openGate(t)
	for _, ch := range []chan error{bgDone, brDone} {
		if err := <-ch; err != nil {
			t.Fatalf("Ensure: %v", err)
		}
	}
	if pf.spawnCount() != 1 {
		t.Fatalf("spawns = %d, want 1 (the join shares the spawn)", pf.spawnCount())
	}
	if n := pf.promotes(); n != 1 {
		t.Fatalf("taskpolicy -B calls = %d, want 1 (the post-ready promote is a no-op)", n)
	}
}

// A page load on a running backend spawns nothing, and counts as activity.
func TestDocumentLoadOnRunningBackendDoesNotRespawn(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	if _, err := pf.wt.Ensure(context.Background(), StartBrowser); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	before := pf.wt.Snapshot().LastActivity
	time.Sleep(5 * time.Millisecond)

	get(pf.proxy, "alpha.localhost:9000", "/", documentLoad)
	waitFor(t, "the page load's touch", func() bool { return pf.wt.Snapshot().LastActivity.After(before) })
	if n := pf.spawnCount(); n != 1 {
		t.Fatalf("spawns = %d, want 1", n)
	}
}

// Only the shell prestarts: an asset (even fetched as a document, e.g. opened
// in a tab) and a non-document load of the shell never start anything.
func TestNonShellOrNonDocumentDoesNotStartBackend(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	host := "alpha.localhost:9000"
	asset := "/artifacts/tasks.web.abc123/index.js"
	if rec := get(pf.proxy, host, asset, map[string]string{"Sec-Fetch-Dest": "script"}); rec.Code != http.StatusOK {
		t.Fatalf("asset status %d", rec.Code)
	}
	get(pf.proxy, host, asset, documentLoad)
	get(pf.proxy, host, "/", map[string]string{"Sec-Fetch-Dest": "empty"}) // a fetch() of the shell
	get(pf.proxy, host, "/", nil)                                          // curl
	time.Sleep(300 * time.Millisecond)
	if s := pf.state(); s != "idle" || pf.spawnCount() != 0 {
		t.Fatalf("state = %q, spawns = %d; want idle, 0", s, pf.spawnCount())
	}
}

// A headless worktree (no web dir) serves no shell, so a document load starts
// nothing.
func TestHeadlessDocumentLoadDoesNotStartBackend(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	spec := *pf.wt.Spec()
	spec.Web = ""
	pf.wt.UpdateSpec(&spec)

	if rec := get(pf.proxy, "alpha.localhost:9000", "/", documentLoad); rec.Code != http.StatusNotFound {
		t.Fatalf("headless status = %d, want 404", rec.Code)
	}
	time.Sleep(300 * time.Millisecond)
	if s := pf.state(); s != "idle" || pf.spawnCount() != 0 {
		t.Fatalf("state = %q, spawns = %d; want idle, 0", s, pf.spawnCount())
	}
}
