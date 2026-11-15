package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestPrincipalOf(t *testing.T) {
	cases := []struct {
		name string
		host string
		h    map[string]string
		want string
	}{
		{"cross-site", "a.localhost:9000", map[string]string{"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"}, "anonymous"},
		{"same-site sibling", "b.localhost:9000", map[string]string{"Origin": "http://a.localhost:9000", "Sec-Fetch-Site": "same-site"}, "anonymous"},
		{"origin null cross-site", "a.localhost:9000", map[string]string{"Origin": "null", "Sec-Fetch-Site": "cross-site"}, "anonymous"},
		{"rebinding", "evil.com:9000", map[string]string{"Origin": "http://evil.com:9000", "Sec-Fetch-Site": "same-origin"}, "anonymous"},
		{"local tool localhost", "localhost:9000", nil, "owner"},
		{"local tool equin", "equin.localhost:9000", nil, "owner"},
		{"typed url", "a.localhost:9000", map[string]string{"Sec-Fetch-Site": "none"}, "owner"},
		{"same-origin", "a.localhost:9000", map[string]string{"Sec-Fetch-Site": "same-origin"}, "owner"},
		{"old browser match", "a.localhost:9000", map[string]string{"Origin": "http://a.localhost:9000"}, "owner"},
		{"old browser match case", "a.localhost:9000", map[string]string{"Origin": "http://A.localhost:9000"}, "owner"},
		{"old browser mismatch", "a.localhost:9000", map[string]string{"Origin": "http://b.localhost:9000"}, "anonymous"},
		{"bare 127.0.0.1", "127.0.0.1:9000", map[string]string{"Sec-Fetch-Site": "same-origin"}, "owner"},
		{"bare [::1]", "[::1]:9000", map[string]string{"Sec-Fetch-Site": "same-origin"}, "owner"},
		{"foreign host no headers", "evil.com", nil, "anonymous"},
	}
	publicHosts := parsePublicHosts("Equin.ai., other.example")
	cases = append(cases, []struct {
		name string
		host string
		h    map[string]string
		want string
	}{
		// Through the public edge: never the owner, whatever the headers say.
		{"public host same-origin", "equin.ai", map[string]string{"Origin": "https://equin.ai", "Sec-Fetch-Site": "same-origin"}, "visitor"},
		{"public host old browser https", "equin.ai", map[string]string{"Origin": "https://equin.ai"}, "visitor"},
		{"public host no headers (curl)", "equin.ai", nil, "visitor"},
		{"public host typed url", "equin.ai", map[string]string{"Sec-Fetch-Site": "none"}, "visitor"},
		{"public host port and case", "EQUIN.AI.:443", nil, "visitor"},
		{"public host via caddy", "equin.ai", map[string]string{"X-Forwarded-For": "203.0.113.9", "X-Forwarded-Proto": "https", "X-Forwarded-Host": "equin.ai"}, "visitor"},
		{"public host cross-site", "equin.ai", map[string]string{"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"}, "visitor"},
		{"loopback via a proxy", "127.0.0.1:9100", map[string]string{"X-Forwarded-For": "203.0.113.9"}, "visitor"},
		{"namespace via a proxy", "equin.localhost:9000", map[string]string{"X-Forwarded-Proto": "https"}, "visitor"},
		{"loopback Forwarded", "localhost:9000", map[string]string{"Forwarded": "for=203.0.113.9"}, "visitor"},
		{"loopback forwarded host only", "localhost:9000", map[string]string{"X-Forwarded-Host": "equin.ai"}, "visitor"},
		{"box-local tool on loopback", "127.0.0.1:9100", nil, "owner"},
		{"unlisted host", "evil.com", map[string]string{"Origin": "https://evil.com", "Sec-Fetch-Site": "same-origin"}, "anonymous"},
	}...)
	for _, c := range cases {
		req := httptest.NewRequest(http.MethodPost, "http://"+c.host+"/api/x", nil)
		req.Host = c.host
		for k, v := range c.h {
			req.Header.Set(k, v)
		}
		if got := principalOf(req, publicHosts); got != c.want {
			t.Errorf("%s: principalOf = %q, want %q", c.name, got, c.want)
		}
	}
}

func crossSiteReq(method, path string) *http.Request {
	req := httptest.NewRequest(method, "http://a.localhost:9000"+path, nil)
	req.Host = "a.localhost:9000"
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	return req
}

func TestProxyGateRefusesAnonymousGatewayWrite(t *testing.T) {
	rec := httptest.NewRecorder()
	newTestProxy(t, "").ServeHTTP(rec, crossSiteReq(http.MethodPost, "/gateway/worktrees/x/restart"))
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `"reason":"cross-site-refused"`) {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type %q", ct)
	}
}

func TestProxyGateRefusesAnonymousWebSocket(t *testing.T) {
	req := crossSiteReq(http.MethodGet, "/ws/live")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")
	rec := httptest.NewRecorder()
	newTestProxy(t, "").ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "cross-site-refused") {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
}

// gatewayAPIPaths reads every "/gateway/…" string literal out of the
// gateway's own (non-test) sources: the routes handleGatewayAPI dispatches,
// spelled where they are matched. A route added later is in this list the day
// it is written, so the test below covers it without being edited.
func gatewayAPIPaths(t *testing.T) []string {
	t.Helper()
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	lit := regexp.MustCompile(`"(/gateway/[^"]*)"`)
	seen := map[string]bool{}
	var paths []string
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range lit.FindAllStringSubmatch(string(src), -1) {
			p := m[1]
			// A prefix ("/gateway/worktrees/") is matched with a name after it.
			if strings.HasSuffix(p, "/") {
				p += "x/stop"
			}
			if !seen[p] {
				seen[p] = true
				paths = append(paths, p)
			}
		}
	}
	if len(paths) < 5 {
		t.Fatalf("found only %d /gateway/ routes in the sources: %v", len(paths), paths)
	}
	return paths
}

// Nothing under /gateway/ answers anyone but the owner: not a visitor through
// a deployed site's edge (a stranger's curl to equin.ai with no browser
// headers, or forging same-origin ones), not a foreign page — any method.
func TestGatewayAPIRefusesEveryoneButTheOwner(t *testing.T) {
	publicHosts := parsePublicHosts("equin.ai")
	callers := map[string]func(method, path string) *http.Request{
		"public curl": func(method, path string) *http.Request {
			req := httptest.NewRequest(method, "http://equin.ai"+path, nil)
			req.Host = "equin.ai"
			return req
		},
		"public forged same-origin": func(method, path string) *http.Request {
			req := httptest.NewRequest(method, "http://equin.ai"+path, nil)
			req.Host = "equin.ai"
			req.Header.Set("Sec-Fetch-Site", "same-origin")
			req.Header.Set("Origin", "https://equin.ai")
			return req
		},
		"through caddy on loopback": func(method, path string) *http.Request {
			req := httptest.NewRequest(method, "http://127.0.0.1:9100"+path, nil)
			req.Host = "127.0.0.1:9100"
			req.Header.Set("X-Forwarded-For", "203.0.113.9")
			return req
		},
		"cross-site page": crossSiteReq,
	}
	for _, path := range gatewayAPIPaths(t) {
		for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodOptions} {
			for name, mk := range callers {
				p := newTestProxy(t, "")
				p.publicHosts = publicHosts
				rec := httptest.NewRecorder()
				p.ServeHTTP(rec, mk(method, path))
				if rec.Code != http.StatusForbidden || (method != http.MethodHead && !strings.Contains(rec.Body.String(), `"reason":"cross-site-refused"`)) {
					t.Errorf("%s %s %s: got %d %q, want 403 cross-site-refused", name, method, path, rec.Code, rec.Body.String())
				}
			}
		}
	}
}

func TestProxyGateAllowsOwnerGatewayRead(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "http://localhost:9000/gateway/worktrees", nil)
	req.Host = "localhost:9000"
	rec := httptest.NewRecorder()
	newTestProxy(t, "").ServeHTTP(rec, req)
	if rec.Code == http.StatusForbidden {
		t.Fatalf("a local tool's GET must pass the principal gate, got 403")
	}
}

// A visitor's request reaches its backend stamped visitor — never owner, and
// never what the visitor sent.
func TestProxyStampsVisitor(t *testing.T) {
	p := newTestProxy(t, "")
	p.publicHosts = parsePublicHosts("equin.ai")
	req := httptest.NewRequest(http.MethodGet, "http://equin.ai/api/x", nil)
	req.Host = "equin.ai"
	req.Header.Set(principalHeader, "owner")
	p.ServeHTTP(httptest.NewRecorder(), req)
	if got := req.Header.Get(principalHeader); got != "visitor" {
		t.Fatalf("principal header = %q, want visitor", got)
	}
}

func TestProxyGateAllowsOwnerGatewayWrite(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "http://a.localhost:9000/gateway/worktrees/x/restart", nil)
	req.Host = "a.localhost:9000"
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	rec := httptest.NewRecorder()
	newTestProxy(t, "").ServeHTTP(rec, req)
	if strings.Contains(rec.Body.String(), "cross-site-refused") {
		t.Fatalf("owner refused: %d %q", rec.Code, rec.Body.String())
	}
}

func TestProxyOverwritesClientPrincipal(t *testing.T) {
	req := crossSiteReq(http.MethodGet, "/api/x")
	req.Header.Set(principalHeader, "owner")
	newTestProxy(t, "").ServeHTTP(httptest.NewRecorder(), req)
	if got := req.Header.Get(principalHeader); got != "anonymous" {
		t.Fatalf("principal header = %q, want anonymous", got)
	}
	own := httptest.NewRequest(http.MethodGet, "http://a.localhost:9000/api/x", nil)
	own.Host = "a.localhost:9000"
	newTestProxy(t, "").ServeHTTP(httptest.NewRecorder(), own)
	if got := own.Header.Get(principalHeader); got != "owner" {
		t.Fatalf("principal header = %q, want owner", got)
	}
}
