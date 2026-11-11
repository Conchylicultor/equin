package main

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

const snapshotShell = `<html><head><meta charset="UTF-8" /><title>equin</title></head>` +
	`<body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>`

// writeSnapshot writes a dist's snapshot the way the build does: fragments
// first, the manifest last, renamed into place (a new inode per revision).
func writeSnapshot(t *testing.T, web, manifest string, fragments map[string]string) {
	t.Helper()
	dir := filepath.Join(web, "snapshot")
	for name, body := range fragments {
		file := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	tmp := filepath.Join(dir, "manifest.json.tmp")
	if err := os.WriteFile(tmp, []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, filepath.Join(dir, "manifest.json")); err != nil {
		t.Fatal(err)
	}
}

const downloadManifest = `{"pages":{"/website/download":{"title":"Download","description":"One command.","file":"website/download.html"}}}`

func snapshotFixture(t *testing.T) staticFixture {
	t.Helper()
	f := newStaticProxy(t)
	withShell(t, f, snapshotShell)
	writeSnapshot(t, f.web, downloadManifest, map[string]string{"website/download.html": "<h1>Download</h1><p>Run it.</p>"})
	return f
}

// A listed path gets its title (replacing the shell's), description,
// canonical link, the hiding rule in the head, and its fragment right after
// the root div.
func TestSnapshotSplicedOnListedPath(t *testing.T) {
	f := snapshotFixture(t)
	rec := serve(f.proxy, "alpha.localhost:9000", "/website/download")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%q", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, part := range []string{
		`<title>Download</title>`,
		`<meta name="description" content="One command.">`,
		`<link rel="canonical" href="http://alpha.localhost:9000/website/download">`,
		snapshotHideHead + `</head>`,
		`<div id="root"></div><div id="equin-snapshot"><h1>Download</h1><p>Run it.</p></div><script`,
	} {
		if !strings.Contains(body, part) {
			t.Errorf("missing %q in %q", part, body)
		}
	}
	if strings.Count(body, "<title>") != 1 || strings.Contains(body, "<title>equin</title>") {
		t.Errorf("the shell's <title> must be replaced, not doubled: %q", body)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("Cache-Control = %q", got)
	}
	if etag := rec.Header().Get("ETag"); !strings.HasPrefix(etag, `"sh-`) {
		t.Errorf("ETag = %q, want a strong hash of the bytes", etag)
	}
}

// The canonical scheme is what a TLS proxy in front reports.
func TestSnapshotCanonicalHonoursForwardedProto(t *testing.T) {
	f := snapshotFixture(t)
	req := httptest.NewRequest(http.MethodGet, "http://alpha.localhost:9000/website/download", nil)
	req.Host = "alpha.localhost:9000"
	req.Header.Set("X-Forwarded-Proto", "HTTPS, http")
	rec := httptest.NewRecorder()
	f.proxy.ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), `href="https://alpha.localhost:9000/website/download"`) {
		t.Fatalf("canonical not https: %q", rec.Body.String())
	}
}

// Trailing slash, repeated slashes and a query all look up the page's key; the
// canonical is the key, never the request's spelling.
func TestSnapshotRequestPathNormalized(t *testing.T) {
	f := snapshotFixture(t)
	for _, p := range []string{"/website/download/", "//website//download", "/website/download?x=1"} {
		body := serve(f.proxy, "alpha.localhost:9000", p).Body.String()
		if !strings.Contains(body, `id="equin-snapshot"`) {
			t.Errorf("%s: no snapshot in %q", p, body)
		}
		if !strings.Contains(body, `href="http://alpha.localhost:9000/website/download"`) {
			t.Errorf("%s: canonical is not the page path: %q", p, body)
		}
	}
}

// An unlisted path is the plain shell, byte for byte.
func TestSnapshotUnlistedPathUntouched(t *testing.T) {
	f := snapshotFixture(t)
	for _, p := range []string{"/website", "/website/downloads", "/home", "/"} {
		rec := serve(f.proxy, "alpha.localhost:9000", p)
		if rec.Code != http.StatusOK || rec.Body.String() != snapshotShell {
			t.Errorf("%s: status=%d body=%q", p, rec.Code, rec.Body.String())
		}
	}
}

// A manifest naming a home answers bare `/` (and only `/`) with a 301 to it,
// the query kept: robots reach the snapshot from the most-linked address.
func TestSnapshotHomeRedirectsRoot(t *testing.T) {
	f := newStaticProxy(t)
	withShell(t, f, snapshotShell)
	writeSnapshot(t, f.web,
		`{"home":"/website","pages":{"/website":{"title":"equin","description":"The app.","file":"website.html"}}}`,
		map[string]string{"website.html": "<h1>equin</h1>"})
	for p, want := range map[string]string{"/": "/website", "/?utm=x&a=1": "/website?utm=x&a=1"} {
		rec := serve(f.proxy, "alpha.localhost:9000", p)
		if rec.Code != http.StatusMovedPermanently || rec.Header().Get("Location") != want {
			t.Errorf("%s: status=%d Location=%q, want 301 to %q", p, rec.Code, rec.Header().Get("Location"), want)
		}
	}
	// The home itself, and any other path, is served as before.
	if rec := serve(f.proxy, "alpha.localhost:9000", "/website"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `id="equin-snapshot"`) {
		t.Errorf("/website: status=%d body=%q", rec.Code, rec.Body.String())
	}
	if rec := serve(f.proxy, "alpha.localhost:9000", "/other"); rec.Code != http.StatusOK {
		t.Errorf("/other: status=%d", rec.Code)
	}
}

// No manifest: today's behaviour, the plain shell.
func TestSnapshotMissingManifestIsPlainShell(t *testing.T) {
	f := newStaticProxy(t)
	rec := serve(f.proxy, "alpha.localhost:9000", "/website/download")
	if rec.Code != http.StatusOK || rec.Body.String() != "<html>spa-shell</html>" {
		t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
	}
}

// Title, description and the canonical href are escaped; the fragment is the
// build's trusted HTML, inserted as is.
func TestSnapshotEscapes(t *testing.T) {
	f := newStaticProxy(t)
	withShell(t, f, snapshotShell)
	writeSnapshot(t, f.web,
		`{"pages":{"/a":{"title":"A <b> & \"c\"","description":"it's <x>","file":"a.html"}}}`,
		map[string]string{"a.html": "<p>&amp;</p>"})
	req := httptest.NewRequest(http.MethodGet, "http://alpha.localhost:9000/a", nil)
	req.Host = `alpha.localhost:9000`
	rec := httptest.NewRecorder()
	f.proxy.ServeHTTP(rec, req)
	body := rec.Body.String()
	for _, part := range []string{
		`<title>A &lt;b&gt; &amp; &#34;c&#34;</title>`,
		`content="it&#39;s &lt;x&gt;"`,
		`<div id="equin-snapshot"><p>&amp;</p></div>`,
	} {
		if !strings.Contains(body, part) {
			t.Errorf("missing %q in %q", part, body)
		}
	}
	if got := requestOrigin(`x"><script>`, ""); got != `http://x"><script>` {
		t.Fatalf("requestOrigin = %q", got)
	}
	out, err := spliceSnapshot([]byte(snapshotShell), snapshotPage{title: "t", description: "d"}, `http://x"><script>/a`)
	if err != nil || !strings.Contains(string(out), `href="http://x&#34;&gt;&lt;script&gt;/a"`) {
		t.Fatalf("canonical not escaped: %v %q", err, out)
	}
}

// The ETag names the bytes: unchanged → 304; a new build's fragment → new ETag.
func TestSnapshotETagFollowsContent(t *testing.T) {
	f := snapshotFixture(t)
	first := serve(f.proxy, "alpha.localhost:9000", "/website/download")
	etag := first.Header().Get("ETag")
	req := httptest.NewRequest(http.MethodGet, "http://alpha.localhost:9000/website/download", nil)
	req.Host = "alpha.localhost:9000"
	req.Header.Set("If-None-Match", etag)
	rec := httptest.NewRecorder()
	f.proxy.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("unchanged: status = %d, want 304", rec.Code)
	}

	writeSnapshot(t, f.web, downloadManifest, map[string]string{"website/download.html": "<h1>Download v2</h1>"})
	again := serve(f.proxy, "alpha.localhost:9000", "/website/download")
	if again.Header().Get("ETag") == etag || !strings.Contains(again.Body.String(), "Download v2") {
		t.Fatalf("a new snapshot must be served fresh: etag=%q body=%q", again.Header().Get("ETag"), again.Body.String())
	}
}

// A build swaps the web symlink to a new dist: the next request serves it.
func TestSnapshotFollowsDistSwap(t *testing.T) {
	f := newStaticProxy(t)
	link := filepath.Join(t.TempDir(), "web")
	distA, distB := t.TempDir(), t.TempDir()
	for dist, text := range map[string]string{distA: "build A", distB: "build B"} {
		if err := os.WriteFile(filepath.Join(dist, "index.html"), []byte(snapshotShell), 0o644); err != nil {
			t.Fatal(err)
		}
		writeSnapshot(t, dist, downloadManifest, map[string]string{"website/download.html": text})
	}
	if err := os.Symlink(distA, link); err != nil {
		t.Fatal(err)
	}
	wt := f.reg.Resolve("alpha")
	if !strings.Contains(serveShellBody(t, wt, link), "build A") {
		t.Fatal("first dist not served")
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(distB, link); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(serveShellBody(t, wt, link), "build B") {
		t.Fatal("swapped dist not served")
	}
}

func serveShellBody(t *testing.T, wt *Worktree, webDir string) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "http://alpha.localhost:9000/website/download", nil)
	req.Host = "alpha.localhost:9000"
	rec := httptest.NewRecorder()
	serveShell(rec, req, wt, webDir)
	return rec.Body.String()
}

// A listed page whose fragment is missing fails that path loudly (500 naming
// it); the other pages and unlisted paths still serve.
func TestSnapshotMissingFragmentFailsThatPath(t *testing.T) {
	f := newStaticProxy(t)
	withShell(t, f, snapshotShell)
	writeSnapshot(t, f.web,
		`{"pages":{"/a":{"title":"A","description":"a","file":"a.html"},"/b":{"title":"B","description":"b","file":"b.html"}}}`,
		map[string]string{"a.html": "<p>a</p>"})
	rec := serve(f.proxy, "alpha.localhost:9000", "/b")
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "b.html") {
		t.Fatalf("/b: status=%d body=%q", rec.Code, rec.Body.String())
	}
	if rec := serve(f.proxy, "alpha.localhost:9000", "/a"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<p>a</p>") {
		t.Fatalf("/a: status=%d body=%q", rec.Code, rec.Body.String())
	}
	if rec := serve(f.proxy, "alpha.localhost:9000", "/c"); rec.Code != http.StatusOK {
		t.Fatalf("/c: status=%d", rec.Code)
	}
}

// An unusable manifest fails every shell of that dist: which paths it lists
// cannot be known, and a plain shell would hide them from crawlers silently.
func TestSnapshotMalformedManifestFailsLoudly(t *testing.T) {
	for name, manifest := range map[string]string{
		"unparseable":      `{"pages":`,
		"unknown field":    `{"pages":{},"v":1}`,
		"unknown page key": `{"pages":{"/a":{"title":"A","description":"a","file":"a.html","x":1}}}`,
		"no pages":         `{}`,
		"trailing slash":   `{"pages":{"/a/":{"title":"A","description":"a","file":"a.html"}}}`,
		"relative path":    `{"pages":{"a":{"title":"A","description":"a","file":"a.html"}}}`,
		"escaping file":    `{"pages":{"/a":{"title":"A","description":"a","file":"x/../../a.html"}}}`,
		"absolute file":    `{"pages":{"/a":{"title":"A","description":"a","file":"/a.html"}}}`,
		"non-html file":    `{"pages":{"/a":{"title":"A","description":"a","file":"a.txt"}}}`,
		"missing title":    `{"pages":{"/a":{"description":"a","file":"a.html"}}}`,
		"trailing data":    `{"pages":{}} {}`,
		"home not a page":  `{"home":"/b","pages":{"/a":{"title":"A","description":"a","file":"a.html"}}}`,
		"home at root":     `{"home":"/","pages":{"/":{"title":"A","description":"a","file":"a.html"}}}`,
		"relative home":    `{"home":"a","pages":{"/a":{"title":"A","description":"a","file":"a.html"}}}`,
		"empty home":       `{"home":"","pages":{"/a":{"title":"A","description":"a","file":"a.html"}}}`,
		"null home":        `{"home":null,"pages":{"/a":{"title":"A","description":"a","file":"a.html"}}}`,
	} {
		t.Run(name, func(t *testing.T) {
			f := newStaticProxy(t)
			withShell(t, f, snapshotShell)
			writeSnapshot(t, f.web, manifest, map[string]string{"a.html": "<p>a</p>"})
			rec := serve(f.proxy, "alpha.localhost:9000", "/other")
			if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "snapshot") {
				t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
			}
		})
	}
}

// Both splices apply: the document head before </head>, the snapshot too.
func TestSnapshotComposesWithDocumentHead(t *testing.T) {
	f := snapshotFixture(t)
	writeDocumentHead(t, f, "alpha", `{"v":1,"entries":{"/website":"<style id=\"w\">w</style>"}}`)
	body := serve(f.proxy, "alpha.localhost:9000", "/website/download").Body.String()
	if !strings.Contains(body, `<style id="w">w</style>`) || !strings.Contains(body, `id="equin-snapshot"`) || !strings.Contains(body, "<title>Download</title>") {
		t.Fatalf("both splices expected: %q", body)
	}
	if strings.Index(body, `<style id="w">`) > strings.Index(body, "</head>") {
		t.Fatalf("document head not in the head: %q", body)
	}
}

// A listed page on a shell without the root div cannot carry its snapshot: 500.
func TestSnapshotShellWithoutRootFails(t *testing.T) {
	f := snapshotFixture(t)
	withShell(t, f, "<html><head><title>x</title></head><body></body></html>")
	if rec := serve(f.proxy, "alpha.localhost:9000", "/website/download"); rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}

// ─── forwarding /robots.txt and /sitemap.xml ─────────────────

// recordingBackend installs a running backend on wt whose socket is a real
// HTTP server recording each request it receives.
func recordingBackend(t *testing.T, wt *Worktree) <-chan *http.Request {
	t.Helper()
	got := make(chan *http.Request, 8)
	l, err := net.Listen("unix", wt.primarySocketPath())
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- r.Clone(r.Context())
		_, _ = io.WriteString(w, "backend:"+r.URL.Path)
	})}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })

	cmd := exec.Command("sleep", "60")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sleep: %v", err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	bk := &backend{cmd: cmd, exitCh: make(chan struct{}), socketPath: wt.primarySocketPath(), proxy: newReverseProxy(wt.primarySocketPath())}
	go func() {
		_ = cmd.Wait()
		close(bk.exitCh)
	}()
	wt.mu.Lock()
	wt.phase = runningOn(bk)
	wt.mu.Unlock()
	return got
}

func TestRobotsAndSitemapForwardedToBackend(t *testing.T) {
	f := newStaticProxy(t) // no snapshot manifest: forwarded regardless
	got := recordingBackend(t, f.reg.Resolve("alpha"))
	for _, p := range []string{"/robots.txt", "/sitemap.xml", "/sitemap.xml?x=1"} {
		req := httptest.NewRequest(http.MethodGet, "http://alpha.localhost:9000"+p, nil)
		req.Host = "alpha.localhost:9000"
		req.Header.Set("X-Forwarded-Host", "evil.example")
		rec := httptest.NewRecorder()
		f.proxy.ServeHTTP(rec, req)
		path, _, _ := strings.Cut(p, "?")
		if rec.Code != http.StatusOK || rec.Body.String() != "backend:"+path {
			t.Fatalf("%s: status=%d body=%q", p, rec.Code, rec.Body.String())
		}
		r := <-got
		if h := r.Header.Get("X-Forwarded-Host"); h != "alpha.localhost:9000" {
			t.Errorf("%s: X-Forwarded-Host = %q", p, h)
		}
		if h := r.Header.Get("X-Forwarded-Proto"); h != "http" {
			t.Errorf("%s: X-Forwarded-Proto = %q", p, h)
		}
		if h := r.Header.Get(principalHeader); h != principalOwner {
			t.Errorf("%s: principal = %q", p, h)
		}
	}

	// A TLS proxy's scheme and an anonymous (public) visitor reach it as such.
	req := httptest.NewRequest(http.MethodGet, "http://alpha.localhost:9000/robots.txt", nil)
	req.Host = "alpha.localhost:9000"
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	f.proxy.ServeHTTP(httptest.NewRecorder(), req)
	r := <-got
	if h := r.Header.Get("X-Forwarded-Proto"); h != "https" {
		t.Errorf("X-Forwarded-Proto = %q, want the front proxy's https", h)
	}
	if h := r.Header.Get(principalHeader); h != principalAnonymous {
		t.Errorf("cross-site principal = %q, want anonymous", h)
	}
}

func TestOnlyExactRootPathsForwarded(t *testing.T) {
	for _, p := range []string{"/robots.txt.bak", "/robots.txt/", "/sitemap.xml/x", "/x/robots.txt", "/sitemap.xml.gz"} {
		if isBackendPath(p) {
			t.Errorf("%s must not be forwarded", p)
		}
	}
	f := newStaticProxy(t)
	if rec := serve(f.proxy, "alpha.localhost:9000", "/robots.txt.bak"); rec.Body.String() != "<html>spa-shell</html>" {
		t.Fatalf("/robots.txt.bak: %d %q", rec.Code, rec.Body.String())
	}
}
