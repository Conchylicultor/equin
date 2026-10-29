package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseContentHost(t *testing.T) {
	cases := []struct {
		host string
		item string
		ok   bool
	}{
		{"proto-1.content.localhost:9000", "proto-1", true},
		{"PROTO-1.Content.localhost.", "proto-1", true},
		{"content.localhost:9000", "", true},
		{"a.b.content.localhost", "a.b", true}, // a content host, refused by the item syntax
		{"equin.localhost:9000", "", false},
		{"content-x.localhost", "", false},
		{"sonata.att-x.localhost", "", false},
		{"localhost:9000", "", false},
		{"evil.com", "", false},
	}
	for _, c := range cases {
		item, ok := parseContentHost(c.host)
		if item != c.item || ok != c.ok {
			t.Errorf("parseContentHost(%q) = (%q, %v), want (%q, %v)", c.host, item, ok, c.item, c.ok)
		}
	}
}

func TestSplitContentPath(t *testing.T) {
	cases := []struct {
		path, label, rest string
		ok                bool
	}{
		{"/equin/api/prototypes/p/index.html", "equin", "/api/prototypes/p/index.html", true},
		{"/sonata.att-x/api/x", "sonata.att-x", "/api/x", true},
		{"/equin", "", "", false},
		{"//api/x", "", "", false},
		{"/../api/x", "", "", false},
	}
	for _, c := range cases {
		label, rest, ok := splitContentPath(c.path)
		if label != c.label || rest != c.rest || ok != c.ok {
			t.Errorf("splitContentPath(%q) = (%q, %q, %v), want (%q, %q, %v)", c.path, label, rest, ok, c.label, c.rest, c.ok)
		}
	}
}

func contentReq(method, host, path string) *http.Request {
	req := httptest.NewRequest(method, "http://"+host+path, nil)
	req.Host = host
	return req
}

func TestContentHostRefusals(t *testing.T) {
	cases := []struct {
		name   string
		req    *http.Request
		status int
		body   string
	}{
		{"no item", contentReq(http.MethodGet, "content.localhost:9000", "/equin/api/prototypes/p/index.html"), 404, "not a content item"},
		{"dotted item", contentReq(http.MethodGet, "a.b.content.localhost:9000", "/equin/api/x"), 404, "not a content item"},
		{"spa", contentReq(http.MethodGet, "p.content.localhost:9000", "/equin/tasks"), 404, "only content routes"},
		{"root", contentReq(http.MethodGet, "p.content.localhost:9000", "/"), 404, "only content routes"},
		{"gateway api", contentReq(http.MethodGet, "p.content.localhost:9000", "/gateway/worktrees"), 404, "only content routes"},
		{"ws path", contentReq(http.MethodGet, "p.content.localhost:9000", "/equin/ws/live"), 404, "only content routes"},
		{"unknown namespace", contentReq(http.MethodGet, "p.content.localhost:9000", "/nope/api/x"), 404, "unknown namespace: nope"},
	}
	ws := contentReq(http.MethodGet, "p.content.localhost:9000", "/equin/api/x")
	ws.Header.Set("Upgrade", "websocket")
	ws.Header.Set("Connection", "Upgrade")
	cases = append(cases, struct {
		name   string
		req    *http.Request
		status int
		body   string
	}{"websocket", ws, 403, "no socket"})
	sw := contentReq(http.MethodGet, "p.content.localhost:9000", "/equin/api/prototypes/p/sw.js")
	sw.Header.Set("Service-Worker", "script")
	cases = append(cases, struct {
		name   string
		req    *http.Request
		status int
		body   string
	}{"service worker", sw, 403, "Service Worker"})

	for _, c := range cases {
		rec := httptest.NewRecorder()
		newTestProxy(t, "").ServeHTTP(rec, c.req)
		if rec.Code != c.status || !strings.Contains(rec.Body.String(), c.body) || !strings.Contains(rec.Body.String(), "content-refused") {
			t.Errorf("%s: got %d %q", c.name, rec.Code, rec.Body.String())
		}
	}
}

func TestContentHostStampsContent(t *testing.T) {
	req := contentReq(http.MethodGet, "p.content.localhost:9000", "/nope/api/x")
	req.Header.Set(principalHeader, "owner")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	newTestProxy(t, "").ServeHTTP(httptest.NewRecorder(), req)
	if got := req.Header.Get(principalHeader); got != principalContent {
		t.Fatalf("principal header = %q, want content", got)
	}
}

func TestAppFrameAncestors(t *testing.T) {
	if got := appFrameAncestors("p.content.localhost:9000"); got != "http://*.localhost:9000" {
		t.Fatalf("got %q", got)
	}
	if got := appFrameAncestors("p.content.localhost"); got != "http://*.localhost" {
		t.Fatalf("got %q", got)
	}
}
