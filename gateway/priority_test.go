package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestHelperBackend is not a test: it is the backend the priority tests spawn,
// by re-executing this test binary (argv: -test.run=^TestHelperBackend$ --
// [spawns=F] [gate=F] [tiers=F] [crash] [die-after-ready] --namespace N --socket S). It records
// its start in the spawns file (and, with crash, exits 1 right there), binds the socket, records the boot tier each
// readiness probe carries in the tiers file, answers 503 until the gate file
// exists (no gate: ready at once) and 200 to everything after. Run directly,
// it has no --socket and returns.
func TestHelperBackend(t *testing.T) {
	var socket, spawns, gate, tiers string
	crash, dieAfterReady := false, false
	var dieOnce sync.Once
	args := os.Args
	for i, a := range args {
		switch {
		case a == "--socket" && i+1 < len(args):
			socket = args[i+1]
		case strings.HasPrefix(a, "spawns="):
			spawns = strings.TrimPrefix(a, "spawns=")
		case strings.HasPrefix(a, "gate="):
			gate = strings.TrimPrefix(a, "gate=")
		case strings.HasPrefix(a, "tiers="):
			tiers = strings.TrimPrefix(a, "tiers=")
		case a == "crash":
			crash = true
		case a == "die-after-ready":
			dieAfterReady = true
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
	if crash {
		os.Exit(1)
	}
	l, err := net.Listen("unix", socket)
	if err != nil {
		os.Exit(2)
	}
	_ = http.Serve(l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if tier := r.Header.Get(bootTierHeader); tiers != "" && tier != "" {
			if f, err := os.OpenFile(tiers, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
				fmt.Fprintf(f, "%s\n", tier)
				_ = f.Close()
			}
		}
		if gate != "" {
			if _, err := os.Stat(gate); err != nil {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
		}
		w.WriteHeader(http.StatusOK)
		if dieAfterReady {
			// Serving, then gone by code on its own — once ready is answered.
			dieOnce.Do(func() {
				go func() {
					time.Sleep(200 * time.Millisecond)
					fmt.Fprintln(os.Stderr, "error: a write after ready failed")
					os.Exit(3)
				}()
			})
		}
	}))
	os.Exit(0)
}

// priorityFixture is the static-proxy fixture whose worktree spawns the helper
// backend through a fake taskpolicy that logs each call ("-b -- …" for a
// demoted spawn; anything else would be the old no-op "-B -p <pid>" promote,
// which the gateway no longer makes) and execs the target.
type priorityFixture struct {
	staticFixture
	wt      *Worktree
	tpLog   string // the fake taskpolicy's call log
	spawns  string // one line per helper backend started
	gate    string // create to make the backend ready
	tiers   string // one line per readiness probe: the boot tier it carried
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
		tiers:         filepath.Join(dir, "tiers"),
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

	command := []string{os.Args[0], "-test.run=^TestHelperBackend$", "--", "spawns=" + pf.spawns, "tiers=" + pf.tiers}
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

// demotedSpawns counts the fake taskpolicy's demoted spawns; outsidePromotes
// its "-B -p <pid>" calls (a no-op on a real host, so never made); probesAt
// the readiness probes that carried tier.
func (pf priorityFixture) demotedSpawns() int   { return countPrefix(readLines(pf.tpLog), "-b_--") }
func (pf priorityFixture) outsidePromotes() int { return countPrefix(readLines(pf.tpLog), "-B") }
func (pf priorityFixture) probesAt(tier string) int {
	return countPrefix(readLines(pf.tiers), tier)
}
func (pf priorityFixture) spawnCount() int { return len(readLines(pf.spawns)) }

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

// A non-browser /api call (an agent's MCP tool, a script) spawns demoted, and
// its readiness probe says so: the backend stays darwinbg until ready (and
// leaves on its own then). No promote from outside — it would change nothing.
func TestNonBrowserAPIStartsDemoted(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	rec := get(pf.proxy, "alpha.localhost:9000", "/api/tasks", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("api: status %d body %q", rec.Code, rec.Body.String())
	}
	if n := pf.demotedSpawns(); n != 1 {
		t.Fatalf("taskpolicy -b calls = %d, want 1", n)
	}
	if n := pf.probesAt(bootTierBackground); n < 1 {
		t.Fatalf("probes at %s = %d, want ≥ 1", bootTierBackground, n)
	}
	if n := pf.probesAt(bootTierForeground); n != 0 {
		t.Fatalf("probes at %s = %d, want 0 (nothing promoted it before ready)", bootTierForeground, n)
	}
	if n := pf.outsidePromotes(); n != 0 {
		t.Fatalf("taskpolicy -B calls = %d, want 0", n)
	}
}

// A client cannot speak for the gateway: a proxied request's boot-tier header
// is stripped, so only the readiness probe ever carries one.
func TestClientBootTierHeaderIsStripped(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	rec := get(pf.proxy, "alpha.localhost:9000", "/api/tasks", map[string]string{bootTierHeader: "client-sent"})
	if rec.Code != http.StatusOK {
		t.Fatalf("api: status %d", rec.Code)
	}
	if n := pf.probesAt("client-sent"); n != 0 {
		t.Fatalf("the backend saw the client's boot tier %d times", n)
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
	go func() { _, err := pf.wt.Ensure(ctx, StartBackground, "test"); bgDone <- err }()
	waitFor(t, "the demoted background spawn probed at background", func() bool {
		return pf.demotedSpawns() == 1 && pf.spawnCount() == 1 && pf.probesAt(bootTierBackground) > 0
	})
	if pf.probesAt(bootTierForeground) != 0 {
		t.Fatal("background spawn told to leave darwinbg before anyone joined")
	}

	brDone := make(chan error, 1)
	go func() { _, err := pf.wt.Ensure(ctx, StartBrowser, "test"); brDone <- err }()
	waitFor(t, "a probe telling the backend to leave darwinbg", func() bool { return pf.probesAt(bootTierForeground) > 0 })
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
	if n := pf.outsidePromotes(); n != 0 {
		t.Fatalf("taskpolicy -B calls = %d, want 0", n)
	}
}

// A page load on a running backend spawns nothing, and counts as activity.
func TestDocumentLoadOnRunningBackendDoesNotRespawn(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	if _, err := pf.wt.Ensure(context.Background(), StartBrowser, "test"); err != nil {
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

// A failed boot is not retried by background traffic: the request gets the
// failure (ErrBootFailed) and nothing spawns — however often it polls. A
// deploy retries it at once (new code is not a retry); a browser start too,
// once the cooldown has passed.
func TestFailedBootIsNotRetriedByBackgroundTraffic(t *testing.T) {
	pf := newPriorityFixture(t, "alpha", false)
	spec := *pf.wt.Spec()
	spec.Command = append(append([]string{}, spec.Command...), "crash")
	pf.wt.UpdateSpec(&spec)
	pf.wt.cfg.BrokenCooldown = time.Hour
	ctx := context.Background()

	if _, err := pf.wt.Ensure(ctx, StartBackground, "test"); !errors.Is(err, ErrSpawnFailed) {
		t.Fatalf("first boot: err = %v, want ErrSpawnFailed", err)
	}
	if s := pf.state(); s != "broken" {
		t.Fatalf("state = %q, want broken", s)
	}
	for i := 0; i < 3; i++ {
		_, err := pf.wt.Ensure(ctx, StartBackground, "test")
		if !errors.Is(err, ErrBootFailed) || !strings.Contains(err.Error(), "exited before ready") {
			t.Fatalf("poll %d: err = %v, want ErrBootFailed naming the failure", i, err)
		}
	}
	rec := get(pf.proxy, "alpha.localhost:9000", "/api/tasks", nil)
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "redeploy") {
		t.Fatalf("api: status %d body %q, want 502 saying how to retry", rec.Code, rec.Body.String())
	}
	if n := pf.spawnCount(); n != 1 {
		t.Fatalf("spawns = %d, want 1 (background traffic retried a failed boot)", n)
	}

	// Inside the hour-long cooldown: a deploy spawns, a browser start waits.
	if _, err := pf.wt.Ensure(ctx, StartDeploy, "test"); !errors.Is(err, ErrSpawnFailed) {
		t.Fatalf("deploy: err = %v, want a new (failed) spawn", err)
	}
	if _, err := pf.wt.Ensure(ctx, StartBrowser, "test"); err == nil {
		t.Fatal("browser inside the cooldown: want the last failure")
	}
	if n := pf.spawnCount(); n != 2 {
		t.Fatalf("spawns = %d, want 2 (the deploy's, not the browser's inside the cooldown)", n)
	}
	pf.wt.mu.Lock()
	pf.wt.brokenUntil = time.Time{}
	pf.wt.mu.Unlock()
	if _, err := pf.wt.Ensure(ctx, StartBrowser, "test"); !errors.Is(err, ErrSpawnFailed) {
		t.Fatalf("browser past the cooldown: err = %v, want a new (failed) spawn", err)
	}
	if n := pf.spawnCount(); n != 3 {
		t.Fatalf("spawns = %d, want 3 (deploy and browser each retried)", n)
	}
}
