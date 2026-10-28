package main

import (
	"net/http"
	"net/http/httptest"
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
		{"public host same-origin", "equin.ai", map[string]string{"Origin": "https://equin.ai", "Sec-Fetch-Site": "same-origin"}, "owner"},
		{"public host old browser https", "equin.ai", map[string]string{"Origin": "https://equin.ai"}, "owner"},
		{"public host cross-site", "equin.ai", map[string]string{"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"}, "anonymous"},
		{"public host old browser foreign origin", "equin.ai", map[string]string{"Origin": "https://evil.example"}, "anonymous"},
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

func TestProxyGateLeavesAnonymousGatewayReadOpen(t *testing.T) {
	rec := httptest.NewRecorder()
	newTestProxy(t, "").ServeHTTP(rec, crossSiteReq(http.MethodGet, "/gateway/worktrees"))
	if rec.Code == http.StatusForbidden {
		t.Fatalf("GET must pass the principal gate, got 403")
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
