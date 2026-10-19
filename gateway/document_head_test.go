package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeDocumentHead writes the backend's head file the way the real writer
// does: a temp file renamed into place (a new inode per revision).
func writeDocumentHead(t *testing.T, f staticFixture, name, body string) {
	t.Helper()
	dir := filepath.Join(f.regDir, name)
	tmp := filepath.Join(dir, documentHeadFile+".tmp")
	if err := os.WriteFile(tmp, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, filepath.Join(dir, documentHeadFile)); err != nil {
		t.Fatal(err)
	}
}

func withShell(t *testing.T, f staticFixture, html string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(f.web, "index.html"), []byte(html), 0o644); err != nil {
		t.Fatal(err)
	}
}

const headFile = `{"v":1,"entries":{"":"<style id=\"g\">global</style>","/home":"<style id=\"h\">home</style>"}}`

// The page is served with the entry for its path spliced in before </head>:
// the longest matching app path, at a segment boundary, else "".
func TestShellCarriesTheHeadForItsPath(t *testing.T) {
	f := newStaticProxy(t)
	withShell(t, f, "<html><head><title>x</title></head><body></body></html>")
	writeDocumentHead(t, f, "alpha", headFile)

	cases := map[string]string{
		"/":             "global",
		"/home":         "home",
		"/home/a/b":     "home",
		"//home/a":      "home",
		"/homes":        "global",
		"/agents/c/xyz": "global",
	}
	for path, want := range cases {
		rec := serve(f.proxy, "alpha.localhost:9000", path)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d", path, rec.Code)
		}
		body := rec.Body.String()
		if !strings.Contains(body, ">"+want+"</style></head>") {
			t.Fatalf("%s: want the %q entry before </head>, got %q", path, want, body)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("%s: Cache-Control = %q, want no-cache", path, got)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Fatalf("%s: Content-Type = %q", path, ct)
		}
	}
}

// No file (a backend that has never booted), or one this gateway cannot read,
// serves the plain shell — the page loads, unthemed for a frame.
func TestShellWithoutHeadIsThePlainFile(t *testing.T) {
	f := newStaticProxy(t)
	rec := serve(f.proxy, "alpha.localhost:9000", "/home")
	if rec.Code != http.StatusOK || rec.Body.String() != "<html>spa-shell</html>" {
		t.Fatalf("no head file: status=%d body=%q", rec.Code, rec.Body.String())
	}

	writeDocumentHead(t, f, "alpha", `{"v":2,"entries":{"":"x"}}`)
	rec = serve(f.proxy, "alpha.localhost:9000", "/home")
	if rec.Body.String() != "<html>spa-shell</html>" {
		t.Fatalf("unknown version must not be spliced: %q", rec.Body.String())
	}
}

// The ETag names the bytes served: the same page revalidates to a 304, and a
// new head (a theme change) is a new ETag — never a 304 for stale bytes.
func TestShellETagFollowsTheHead(t *testing.T) {
	f := newStaticProxy(t)
	withShell(t, f, "<html><head></head></html>")
	writeDocumentHead(t, f, "alpha", headFile)

	first := serve(f.proxy, "alpha.localhost:9000", "/home")
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("no ETag on a spliced shell")
	}
	req := httptest.NewRequest(http.MethodGet, "http://alpha.localhost:9000/home", nil)
	req.Host = "alpha.localhost:9000"
	req.Header.Set("If-None-Match", etag)
	rec := httptest.NewRecorder()
	f.proxy.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("unchanged page: status = %d, want 304", rec.Code)
	}

	if other := serve(f.proxy, "alpha.localhost:9000", "/").Header().Get("ETag"); other == etag {
		t.Fatal("two paths with different heads share an ETag")
	}

	writeDocumentHead(t, f, "alpha", strings.Replace(headFile, ">home<", ">home-v2<", 1))
	again := serve(f.proxy, "alpha.localhost:9000", "/home")
	if again.Header().Get("ETag") == etag || !strings.Contains(again.Body.String(), "home-v2") {
		t.Fatalf("a rewritten head must be served fresh: etag=%q body=%q", again.Header().Get("ETag"), again.Body.String())
	}
}

// An explicit /index.html is still redirected to the directory form, never
// served with a head (the document lives at paths, not at its file name).
func TestExplicitIndexStillRedirectsWithHead(t *testing.T) {
	f := newStaticProxy(t)
	withShell(t, f, "<html><head></head></html>")
	writeDocumentHead(t, f, "alpha", headFile)
	rec := serve(f.proxy, "alpha.localhost:9000", "/index.html")
	if rec.Code != http.StatusMovedPermanently {
		t.Fatalf("status = %d, want 301", rec.Code)
	}
}

func TestMatchDocumentHead(t *testing.T) {
	entries := map[string]string{"": "g", "/a": "a", "/a/b": "ab"}
	cases := map[string]string{"/": "g", "/a": "a", "/a/x": "a", "/a/b/c": "ab", "/ab": "g"}
	for path, want := range cases {
		if got := matchDocumentHead(entries, path); got != want {
			t.Errorf("matchDocumentHead(%q) = %q, want %q", path, got, want)
		}
	}
	if got := matchDocumentHead(map[string]string{"/a": "a"}, "/b"); got != "" {
		t.Errorf("no \"\" entry and no match: got %q, want empty", got)
	}
}
