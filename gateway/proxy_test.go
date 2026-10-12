package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newTestProxy builds a Proxy with an empty registry and no central routes — so
// any resolved namespace falls through to a `reg.Resolve(name) == nil` "unknown
// worktree: <name>" 404 (RegistryDir is unset, so Resolve never touches disk).
// That message reveals WHICH namespace the router resolved, which is exactly what
// these routing tests assert on.
func newTestProxy(t *testing.T, defaultNamespace string) *Proxy {
	t.Helper()
	cfg := &Config{SocketsDir: t.TempDir(), ChildEnv: testChildEnv(t)}
	reg := NewRegistry(cfg)
	routes := NewCentralRoutesStore(filepath.Join(t.TempDir(), "central-routes.json")) // unloaded ⇒ Match==""
	return NewProxy(reg, routes, &Supervisor{}, defaultNamespace)
}

func serve(p *Proxy, host, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "http://"+host+path, nil)
	req.Host = host
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)
	return rec
}

// Without a default namespace, a subdomain-less request still gets the generic
// gateway 404 — today's behavior, unchanged for dev/multi-app.
func TestNoDefaultNamespaceBareLocalhost404(t *testing.T) {
	rec := serve(newTestProxy(t, ""), "localhost:9000", "/")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Use <name>.localhost") {
		t.Fatalf("expected generic gateway 404, got %q", rec.Body.String())
	}
}

// With a default namespace, a subdomain-less request resolves to it and proceeds
// to registry lookup (here: not found ⇒ "unknown worktree: sonata"). The generic
// gateway 404 is NOT returned — proving the fallback engaged.
func TestDefaultNamespaceRoutesBareLocalhost(t *testing.T) {
	rec := serve(newTestProxy(t, "sonata"), "localhost:9000", "/")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "unknown worktree: sonata") {
		t.Fatalf("expected fallback to namespace 'sonata', got %q", body)
	}
	if strings.Contains(body, "Use <name>.localhost") {
		t.Fatalf("default namespace should bypass the generic gateway 404, got %q", body)
	}
}

// An explicit subdomain wins over the default namespace (lowest precedence).
func TestSubdomainBeatsDefaultNamespace(t *testing.T) {
	rec := serve(newTestProxy(t, "sonata"), "other.localhost:9000", "/")
	if !strings.Contains(rec.Body.String(), "unknown worktree: other") {
		t.Fatalf("subdomain should win over default, got %q", rec.Body.String())
	}
}

// /gateway/* stays reserved on the subdomain-less host even with a default set.
func TestGatewayAPIReservedUnderDefaultNamespace(t *testing.T) {
	rec := serve(newTestProxy(t, "sonata"), "localhost:9000", "/gateway/worktrees")
	// handleGatewayAPI answers (200 with a JSON list) — it must NOT fall through
	// to the default-namespace backend path.
	if rec.Code != http.StatusOK {
		t.Fatalf("/gateway/worktrees status = %d, want 200 (reserved path)", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "unknown worktree") {
		t.Fatalf("/gateway/* must not route to the default namespace, got %q", rec.Body.String())
	}
}

// staticFixture is a proxy serving one registered worktree from a real dist dir,
// plus the registry and registry dir behind it — so a test can rewrite the
// worktree's spec.json and observe what handleStatic serves afterwards.
type staticFixture struct {
	proxy  *Proxy
	reg    *Registry
	regDir string
	web    string
}

// newStaticProxy registers a worktree with a real web dist dir (index.html +
// one artifact file) and returns a proxy serving it — exercising handleStatic.
func newStaticProxy(t *testing.T) staticFixture {
	return newStaticProxyNamed(t, "alpha")
}

// Same fixture, under an arbitrary namespace — so the multi-label case can be
// exercised through the SAME serving path as the single-label one rather than a
// parallel one written to pass.
func newStaticProxyNamed(t *testing.T, name string) staticFixture {
	t.Helper()
	regDir := t.TempDir()
	sockDir, err := os.MkdirTemp("/tmp", "gwsta")
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
	reg := NewRegistry(cfg)

	sub := filepath.Join(regDir, name)
	server := filepath.Join(sub, "server")
	if err := os.MkdirAll(server, 0o755); err != nil {
		t.Fatal(err)
	}
	web := t.TempDir()
	if err := os.WriteFile(filepath.Join(web, "index.html"), []byte("<html>spa-shell</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	artifactDir := filepath.Join(web, "artifacts", "tasks.web.abc123")
	if err := os.MkdirAll(artifactDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(artifactDir, "index.js"), []byte("export {};"), 0o644); err != nil {
		t.Fatal(err)
	}
	spec := `{"server":"` + server + `","web":"` + web + `"}`
	if err := os.WriteFile(filepath.Join(sub, "spec.json"), []byte(spec), 0o644); err != nil {
		t.Fatal(err)
	}
	routes := NewCentralRoutesStore(filepath.Join(t.TempDir(), "central-routes.json"))
	return staticFixture{
		proxy:  NewProxy(reg, routes, &Supervisor{}, ""),
		reg:    reg,
		regDir: regDir,
		web:    web,
	}
}

// An existing /artifacts/* file is served as-is.
func TestArtifactsHitServesFile(t *testing.T) {
	p := newStaticProxy(t).proxy
	rec := serve(p, "alpha.localhost:9000", "/artifacts/tasks.web.abc123/index.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "export {}") {
		t.Fatalf("expected artifact body, got %q", rec.Body.String())
	}
}

// A miss is never cacheable: the file may appear under that URL later.
func TestArtifactsMissIsNotImmutable(t *testing.T) {
	p := newStaticProxy(t).proxy
	rec := serve(p, "alpha.localhost:9000", "/artifacts/tasks.web.abc123/missing.js")
	if got := rec.Header().Get("Cache-Control"); strings.Contains(got, "immutable") {
		t.Fatalf("404 Cache-Control = %q, must not be immutable", got)
	}
}

// A missing /artifacts/* file is an honest 404, never the SPA fallback: the
// import-map loader would otherwise receive index.html for a module URL and
// die with a cryptic parse error.
func TestArtifactsMissReturns404NotSPAFallback(t *testing.T) {
	p := newStaticProxy(t).proxy
	rec := serve(p, "alpha.localhost:9000", "/artifacts/tasks.web.abc123/missing.js")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "spa-shell") {
		t.Fatalf("artifact miss must not serve index.html, got %q", rec.Body.String())
	}
}

// Non-artifact unknown paths keep today's SPA fallback.
func TestNonArtifactMissKeepsSPAFallback(t *testing.T) {
	p := newStaticProxy(t).proxy
	rec := serve(p, "alpha.localhost:9000", "/tasks/t/some-route")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (SPA fallback)", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "spa-shell") {
		t.Fatalf("expected index.html fallback, got %q", rec.Body.String())
	}
}

// The SPA shell must never be replayed from a browser cache unasked. Both ways
// it is reached — the direct hit and the SPA fallback — are asserted, because a
// header set on only one of them still hands a new tab a stale bundle for every
// deep link. Without Cache-Control a browser applies heuristic freshness and
// serves its stored copy for minutes to hours after a build.
func TestIndexIsRevalidated(t *testing.T) {
	p := newStaticProxy(t).proxy
	for _, upath := range []string{"/", "/tasks/t/some-route"} {
		rec := serve(p, "alpha.localhost:9000", upath)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200", upath, rec.Code)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("%s: Cache-Control = %q, want %q", upath, got, "no-cache")
		}
	}
}

// An explicit /index.html never serves the document at all: http.ServeFile
// redirects it to the directory form. That redirect is a 301, which a browser
// caches FOREVER by default — so it has to carry the header too, or the one URL
// we are trying to keep revalidated becomes permanently pinned to a redirect.
func TestExplicitIndexRedirectIsRevalidated(t *testing.T) {
	p := newStaticProxy(t).proxy
	rec := serve(p, "alpha.localhost:9000", "/index.html")
	if rec.Code != http.StatusMovedPermanently {
		t.Fatalf("status = %d, want 301", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("Cache-Control = %q, want %q", got, "no-cache")
	}
}

// The converse: a content-addressed artifact is immutable. Its hash IS its
// identity, so there is nothing to revalidate — no-cache, or no header at all
// (heuristic freshness), would cost a round trip per module on every load.
func TestArtifactIsImmutable(t *testing.T) {
	p := newStaticProxy(t).proxy
	rec := serve(p, "alpha.localhost:9000", "/artifacts/tasks.web.abc123/index.js")
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("artifact Cache-Control = %q, want immutable", got)
	}
}

// The end-to-end statement of the fix: after a build rewrites `web` to a new
// dist, the gateway serves the NEW dist. Previously the in-memory spec was
// frozen at first registration, so the gateway kept serving the old path — and
// once anything deleted it, every static asset 404'd while the build reported
// success (its readiness probe is /api/health, which never reaches
// handleStatic).
func TestRewrittenWebPathChangesWhatStaticServes(t *testing.T) {
	f := newStaticProxy(t)

	rec := serve(f.proxy, "alpha.localhost:9000", "/")
	if !strings.Contains(rec.Body.String(), "spa-shell") {
		t.Fatalf("setup: expected the original dist, got %q", rec.Body.String())
	}

	// A new dist, as a build would publish it, and a spec.json rewritten to
	// point at it (atomic temp+rename, matching the real writer).
	newWeb := t.TempDir()
	if err := os.WriteFile(filepath.Join(newWeb, "index.html"), []byte("<html>new-dist</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(f.regDir, "alpha")
	body := `{"server":"` + filepath.Join(sub, "server") + `","web":"` + newWeb + `"}`
	tmp := filepath.Join(sub, "spec.json.tmp")
	if err := os.WriteFile(tmp, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, filepath.Join(sub, "spec.json")); err != nil {
		t.Fatal(err)
	}

	// Nothing is served from the new dist until the gateway observes the rewrite.
	f.reg.reconcileOnce()

	rec = serve(f.proxy, "alpha.localhost:9000", "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "new-dist") {
		t.Fatalf("expected the relocated dist to be served, got %q", rec.Body.String())
	}

	// And the old dist is genuinely no longer the source: deleting it (what the
	// legacy reap does) must not affect serving.
	if err := os.RemoveAll(f.web); err != nil {
		t.Fatal(err)
	}
	rec = serve(f.proxy, "alpha.localhost:9000", "/")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "new-dist") {
		t.Fatalf("removing the old dist must not break serving: status=%d body=%q", rec.Code, rec.Body.String())
	}
}

// parseWorktree is the gateway's whole namespace surface: Host header in, spec-dir
// key out. It is pinned directly (rather than only through ServeHTTP) because the
// multi-label case is the one the composition model turns on, and because the
// loopback short-circuit has to keep winning over the dot handling — `127.0.0.1`
// and `::1` are dot- and colon-bearing hosts that must still mean "no namespace".
func TestParseWorktree(t *testing.T) {
	cases := []struct {
		host string
		want string
	}{
		// Today's two shapes, unchanged.
		{"singularity.localhost:9000", "singularity"},
		{"att-1787064474-2qcq.localhost:9000", "att-1787064474-2qcq"},
		{"sonata.localhost", "sonata"},
		// The shape this change exists for: <composition>.<checkout>.
		{"sonata.att-x.localhost:9000", "sonata.att-x"},
		{"sonata.att-x.localhost", "sonata.att-x"},
		// Case-insensitive, trailing root dot tolerated.
		{"SONATA.att-x.LOCALHOST:9000", "sonata.att-x"},
		{"sonata.att-x.localhost.:9000", "sonata.att-x"},
		// No namespace: loopback in every spelling, and non-.localhost hosts.
		{"localhost:9000", ""},
		{"localhost", ""},
		{"127.0.0.1:9000", ""},
		{"[::1]:9000", ""},
		{"::1", ""},
		{"example.com:9000", ""},
		{"sonata.example.com", ""},
		{".localhost:9000", ""},
	}
	for _, c := range cases {
		if got := parseWorktree(c.host); got != c.want {
			t.Errorf("parseWorktree(%q) = %q, want %q", c.host, got, c.want)
		}
	}
}

// The capability this whole change exists for: a `<composition>.<checkout>`
// namespace is served, end to end, through the real routing + registry + static
// path — not merely parsed.
//
// Before the change this returned the generic "Use <name>.localhost" 404,
// because parseWorktree refused any name containing a dot. That exact
// distinction is what the body assertions below pin: the generic message means
// the ROUTER rejected the host, while "unknown worktree" means it resolved a
// namespace and only the registry missed.
func TestMultiLabelNamespaceServesStatic(t *testing.T) {
	p := newStaticProxyNamed(t, "sonata.att-x").proxy

	rec := serve(p, "sonata.att-x.localhost:9000", "/artifacts/tasks.web.abc123/index.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "export {}") {
		t.Fatalf("expected artifact body, got %q", rec.Body.String())
	}

	// The SPA shell too, so this is not just the artifacts special case.
	rec = serve(p, "sonata.att-x.localhost:9000", "/some/client/route")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "spa-shell") {
		t.Fatalf("SPA fallback under a multi-label namespace: status %d body %q", rec.Code, rec.Body.String())
	}
}

// A sibling namespace that does not exist must resolve as a NAMESPACE and miss
// in the registry ("unknown worktree"), never be rejected by the router. This is
// what proves the dot is being carried through rather than tolerated by accident.
func TestMultiLabelUnknownNamespaceResolvesThenMisses(t *testing.T) {
	p := newStaticProxyNamed(t, "sonata.att-x").proxy
	rec := serve(p, "website.att-x.localhost:9000", "/")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "unknown worktree: website.att-x") {
		t.Fatalf("expected the registry to miss on the full two-label name, got %q", body)
	}
	if strings.Contains(body, "Use <name>.localhost") {
		t.Fatalf("router rejected the multi-label host instead of resolving it: %q", body)
	}
}
