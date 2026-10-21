package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func serveWith(p *Proxy, host, path string, header map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "http://"+host+path, nil)
	req.Host = host
	for k, v := range header {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)
	return rec
}

// withSidecars writes the build's precompressed sidecars beside the fixture's
// artifact module: distinct marker bodies, so a test can tell which was served.
func withSidecars(t *testing.T, f staticFixture, exts ...string) string {
	t.Helper()
	file := filepath.Join(f.web, "artifacts", "tasks.web.abc123", "index.js")
	for _, ext := range exts {
		if err := os.WriteFile(file+ext, []byte("body"+ext), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return "/artifacts/tasks.web.abc123/index.js"
}

func TestAcceptsEncoding(t *testing.T) {
	cases := []struct {
		header, token string
		want          bool
	}{
		{"gzip, deflate, br, zstd", "br", true},
		{"gzip, deflate", "br", false},
		{"GZIP", "gzip", true},
		{"br;q=0, gzip", "br", false},
		{"br;q=0.5", "br", true},
		{"*", "br", true},
		{"*, br;q=0", "br", false},
		{"*;q=0", "gzip", false},
		{"", "gzip", false},
		{"identity", "gzip", false},
	}
	for _, c := range cases {
		if got := acceptsEncoding(c.header, c.token); got != c.want {
			t.Errorf("acceptsEncoding(%q, %q) = %v, want %v", c.header, c.token, got, c.want)
		}
	}
}

// The headline: a client accepting br gets the brotli sidecar, labelled with
// the ORIGINAL file's type (never one sniffed off compressed bytes), still
// immutable, and varying by Accept-Encoding.
func TestArtifactServesBrotliSidecar(t *testing.T) {
	f := newStaticProxy(t)
	url := withSidecars(t, f, ".br", ".gz")
	rec := serveWith(f.proxy, "alpha.localhost:9000", url, map[string]string{"Accept-Encoding": "gzip, deflate, br"})
	if rec.Code != http.StatusOK || rec.Body.String() != "body.br" {
		t.Fatalf("status=%d body=%q, want the .br sidecar", rec.Code, rec.Body.String())
	}
	h := rec.Header()
	if h.Get("Content-Encoding") != "br" {
		t.Fatalf("Content-Encoding = %q", h.Get("Content-Encoding"))
	}
	if ct := h.Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Fatalf("Content-Type = %q, want the .js type", ct)
	}
	if h.Get("Vary") != "Accept-Encoding" {
		t.Fatalf("Vary = %q", h.Get("Vary"))
	}
	if h.Get("Content-Length") != "7" {
		t.Fatalf("Content-Length = %q, want the sidecar's size", h.Get("Content-Length"))
	}
	if !strings.Contains(h.Get("Cache-Control"), "immutable") {
		t.Fatalf("Cache-Control = %q, want immutable", h.Get("Cache-Control"))
	}
}

// A plain-http client (browsers advertise br only in secure contexts) gets gzip.
func TestArtifactFallsBackToGzipSidecar(t *testing.T) {
	f := newStaticProxy(t)
	url := withSidecars(t, f, ".br", ".gz")
	rec := serveWith(f.proxy, "alpha.localhost:9000", url, map[string]string{"Accept-Encoding": "gzip, deflate"})
	if rec.Body.String() != "body.gz" || rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("body=%q encoding=%q, want the .gz sidecar", rec.Body.String(), rec.Header().Get("Content-Encoding"))
	}
}

// No Accept-Encoding, or a Range request: identity bytes — and still Vary, so
// a shared cache never answers a br client with them (or the reverse).
func TestIdentityWhenNotAcceptedOrRanged(t *testing.T) {
	f := newStaticProxy(t)
	url := withSidecars(t, f, ".br", ".gz")
	for name, hdr := range map[string]map[string]string{
		"no accept": {},
		"range":     {"Accept-Encoding": "br, gzip", "Range": "bytes=0-3"},
	} {
		rec := serveWith(f.proxy, "alpha.localhost:9000", url, hdr)
		if rec.Header().Get("Content-Encoding") != "" {
			t.Fatalf("%s: Content-Encoding = %q, want identity", name, rec.Header().Get("Content-Encoding"))
		}
		if !strings.HasPrefix("export {};", rec.Body.String()) || rec.Body.Len() == 0 {
			t.Fatalf("%s: body = %q, want the original bytes", name, rec.Body.String())
		}
		if rec.Header().Get("Vary") != "Accept-Encoding" {
			t.Fatalf("%s: Vary = %q", name, rec.Header().Get("Vary"))
		}
	}
}

// A file the build wrote no sidecar for (incompressible, or under the size
// floor) is served exactly as before: identity, no Vary.
func TestNoSidecarIsServedAsBefore(t *testing.T) {
	f := newStaticProxy(t)
	rec := serveWith(f.proxy, "alpha.localhost:9000", "/artifacts/tasks.web.abc123/index.js", map[string]string{"Accept-Encoding": "br, gzip"})
	if rec.Body.String() != "export {};" || rec.Header().Get("Content-Encoding") != "" || rec.Header().Get("Vary") != "" {
		t.Fatalf("body=%q encoding=%q vary=%q", rec.Body.String(), rec.Header().Get("Content-Encoding"), rec.Header().Get("Vary"))
	}
}

// A type Go's table does not know (PGlite's .data) is opaque bytes, never
// sniffed from the compressed body.
func TestUnknownTypeSidecarIsOctetStream(t *testing.T) {
	f := newStaticProxy(t)
	file := filepath.Join(f.web, "artifacts", "tasks.web.abc123", "pglite.data")
	for _, p := range []string{file, file + ".br"} {
		if err := os.WriteFile(p, []byte("<html>looks like html</html>"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	rec := serveWith(f.proxy, "alpha.localhost:9000", "/artifacts/tasks.web.abc123/pglite.data", map[string]string{"Accept-Encoding": "br"})
	if ct := rec.Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Fatalf("Content-Type = %q", ct)
	}
}

// The plain shell (no head to splice) uses its sidecar too, staying no-cache.
func TestPlainShellServesSidecar(t *testing.T) {
	f := newStaticProxy(t)
	if err := os.WriteFile(filepath.Join(f.web, "index.html.br"), []byte("shell.br"), 0o644); err != nil {
		t.Fatal(err)
	}
	rec := serveWith(f.proxy, "alpha.localhost:9000", "/tasks/t/x", map[string]string{"Accept-Encoding": "br"})
	if rec.Body.String() != "shell.br" || rec.Header().Get("Content-Encoding") != "br" {
		t.Fatalf("body=%q encoding=%q", rec.Body.String(), rec.Header().Get("Content-Encoding"))
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("Content-Type = %q", ct)
	}
	if rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("Cache-Control = %q", rec.Header().Get("Cache-Control"))
	}
}

// The head-spliced shell is built per request, so it is gzipped on the fly —
// decoding to exactly the identity body, under its own validator.
func TestSplicedShellIsGzippedOnTheFly(t *testing.T) {
	f := newStaticProxy(t)
	withShell(t, f, "<html><head><title>x</title></head><body>"+strings.Repeat("<div>pad</div>", 200)+"</body></html>")
	writeDocumentHead(t, f, "alpha", headFile)

	plain := serveWith(f.proxy, "alpha.localhost:9000", "/home", nil)
	zipped := serveWith(f.proxy, "alpha.localhost:9000", "/home", map[string]string{"Accept-Encoding": "gzip, br"})
	if zipped.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("Content-Encoding = %q", zipped.Header().Get("Content-Encoding"))
	}
	zr, err := gzip.NewReader(bytes.NewReader(zipped.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded) != plain.Body.String() {
		t.Fatal("gzipped shell does not decode to the identity shell")
	}
	if zipped.Header().Get("ETag") == plain.Header().Get("ETag") {
		t.Fatal("encoded and identity shells share an ETag")
	}
	if zipped.Header().Get("Vary") != "Accept-Encoding" || plain.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatal("spliced shell must vary by Accept-Encoding")
	}

	// Revalidation still works on the encoded validator.
	again := serveWith(f.proxy, "alpha.localhost:9000", "/home", map[string]string{"Accept-Encoding": "gzip", "If-None-Match": zipped.Header().Get("ETag")})
	if again.Code != http.StatusNotModified {
		t.Fatalf("revalidation status = %d, want 304", again.Code)
	}
}
