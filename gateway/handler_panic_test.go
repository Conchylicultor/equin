package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The entry the writer builds is the shape the TypeScript side reads:
// testdata/gateway-panic-entry.json is parsed by the gateway-panic kind's own
// test (plugins/debug/plugins/gateway-panic/core/kind.test.ts).
func TestGatewayPanicEntryMatchesTheGolden(t *testing.T) {
	p := gatewayPanic{
		Site:    "equin/gateway.(*backend).incHTTP",
		Value:   "runtime error: invalid memory address or nil pointer dereference",
		Stack:   []string{"goroutine 1 [running]:", "equin/gateway.(*backend).incHTTP(0x0)", "\t/x/gateway/worktree.go:227 +0x1c"},
		Method:  "GET",
		Host:    "equin.localhost:9000",
		Path:    "/api/health",
		Count:   240,
		FirstAt: 1794158464000,
		LastAt:  1794159145000,
	}
	got, err := json.Marshal(newGatewayPanicEntry(p, 1234, "/x/gateway"))
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile(filepath.Join("testdata", "gateway-panic-entry.json"))
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
		t.Fatalf("entry drifted from testdata/gateway-panic-entry.json:\n got %s", got)
	}
}

// panickingHandler dereferences a nil backend, the way handleHTTP did on
// 2026-11-08, behind the reporter's recover.
func panickingHandler(pr *panicReporter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		defer pr.recoverHandlerPanic(&startedWriter{ResponseWriter: w}, r)
		var bk *backend
		bk.incHTTP()
	}
}

func servePath(h http.Handler, path string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://equin.localhost:9000"+path, nil))
	return rec
}

// A handler panic answers 500 and is filed at once, named by the function
// that panicked; the ones after it at the same site are counted into one
// entry when the window closes, not filed one per request.
func TestHandlerPanicIsReportedAndCoalesced(t *testing.T) {
	outbox := t.TempDir()
	pr := newPanicReporter(outbox, time.Hour) // closed by hand below
	h := panickingHandler(pr)

	rec := servePath(h, "/api/health")
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "nil pointer dereference") {
		t.Fatalf("response: %d %q", rec.Code, rec.Body.String())
	}
	es := readOutbox[gatewayPanic](t, outbox)
	if len(es) != 1 {
		t.Fatalf("entries after the first panic: %d, want 1", len(es))
	}
	d := es[0].Data
	if es[0].Kind != gatewayPanicKind || d.Site != "equin/gateway.(*backend).incHTTP" || d.Count != 1 || d.Path != "/api/health" || len(d.Stack) == 0 {
		t.Fatalf("first entry: %+v", es[0])
	}

	for range 5 {
		servePath(h, "/api/x")
	}
	if n := len(readOutbox[gatewayPanic](t, outbox)); n != 1 {
		t.Fatalf("entries inside the window: %d, want still 1", n)
	}
	pr.closeWindow(d.Site)
	es = readOutbox[gatewayPanic](t, outbox)
	if len(es) != 2 {
		t.Fatalf("entries after the window closed: %d, want 2", len(es))
	}
	var trailing gatewayPanic
	for _, e := range es {
		if e.Data.Count != 1 {
			trailing = e.Data
		}
	}
	if trailing.Count != 5 || trailing.Path != "/api/x" || trailing.FirstAt > trailing.LastAt {
		t.Fatalf("trailing entry: %+v", trailing)
	}

	// The window is closed: the next panic opens a new one and is filed at once.
	servePath(h, "/api/y")
	if n := len(readOutbox[gatewayPanic](t, outbox)); n != 3 {
		t.Fatalf("entries after a panic in a new window: %d, want 3", n)
	}
}

// http.ErrAbortHandler is net/http's own quiet abort (the reverse proxy
// uses it): let through, never reported.
func TestHandlerAbortIsNotReported(t *testing.T) {
	outbox := t.TempDir()
	pr := newPanicReporter(outbox, time.Hour)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer pr.recoverHandlerPanic(&startedWriter{ResponseWriter: w}, r)
		panic(http.ErrAbortHandler)
	})
	defer func() {
		if v := recover(); v != http.ErrAbortHandler {
			t.Fatalf("recovered %v, want http.ErrAbortHandler re-panicked", v)
		}
		if n := len(readOutbox[gatewayPanic](t, outbox)); n != 0 {
			t.Fatalf("entries: %d, want 0", n)
		}
	}()
	servePath(h, "/api/x")
}

// The proxy's own entry point recovers: a panic anywhere below ServeHTTP is
// a 500 and a report.
func TestProxyServeHTTPRecoversHandlerPanics(t *testing.T) {
	outbox := t.TempDir()
	p := &Proxy{panics: newPanicReporter(outbox, time.Hour)} // nil registry: ServeHTTP panics on its first lookup
	rec := servePath(p, "/api/health")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("response: %d %q", rec.Code, rec.Body.String())
	}
	if n := len(readOutbox[gatewayPanic](t, outbox)); n != 1 {
		t.Fatalf("entries: %d, want 1", n)
	}
}

// A panic after the response started is still reported, but aborts the
// response (http.ErrAbortHandler) instead of appending a 500 to its body.
func TestHandlerPanicAfterTheResponseStartedAborts(t *testing.T) {
	outbox := t.TempDir()
	pr := newPanicReporter(outbox, time.Hour)
	rec := httptest.NewRecorder()
	defer func() {
		if v := recover(); v != http.ErrAbortHandler {
			t.Fatalf("recovered %v, want http.ErrAbortHandler", v)
		}
		if body := rec.Body.String(); body != "partial" {
			t.Fatalf("body %q, want only what was written before the panic", body)
		}
		if n := len(readOutbox[gatewayPanic](t, outbox)); n != 1 {
			t.Fatalf("entries: %d, want 1", n)
		}
	}()
	func() {
		sw := &startedWriter{ResponseWriter: rec}
		defer pr.recoverHandlerPanic(sw, httptest.NewRequest(http.MethodGet, "http://x.localhost:9000/api/x", nil))
		_, _ = sw.Write([]byte("partial"))
		panic("boom")
	}()
}
