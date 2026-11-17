package main

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func TestParseListenFlags(t *testing.T) {
	if _, err := parseListenFlags("", ""); !errors.Is(err, errListenRequired) {
		t.Fatalf("no -listen: %v, want errListenRequired", err)
	}
	if _, err := parseListenFlags("", "loopback:9000"); !errors.Is(err, errListenRequired) {
		t.Fatalf("only -legacy-listen: %v, want errListenRequired", err)
	}
	for _, bad := range [][2]string{
		{"loopback", ""},           // no port
		{"loopback:0", ""},         // "any port": nothing to hand a child
		{"loopback:http", ""},      // not a number
		{"loopback:70000", ""},     // out of range
		{"loopback:8700", "9000"},  // legacy not a host:port
		{"loopback:8700", ":8700"}, // legacy on the main port
	} {
		if _, err := parseListenFlags(bad[0], bad[1]); err == nil {
			t.Errorf("parseListenFlags(%q, %q) accepted", bad[0], bad[1])
		}
	}

	plan, err := parseListenFlags("loopback:8700", "")
	if err != nil {
		t.Fatal(err)
	}
	if plan.mainPort != 8700 || len(plan.main) != 2 || plan.legacy != nil || plan.legacySpec != "" {
		t.Fatalf("main only: %+v", plan)
	}
	plan, err = parseListenFlags("loopback:8700", "loopback:9000")
	if err != nil {
		t.Fatal(err)
	}
	want := []listenAddr{{addr: "127.0.0.1:9000"}, {addr: "[::1]:9000", ipv6Loopback: true}}
	if plan.mainPort != 8700 || plan.legacySpec != "loopback:9000" || !slices.Equal(plan.legacy, want) {
		t.Fatalf("with legacy: %+v", plan)
	}
	if plan, err = parseListenFlags(":8701", "127.0.0.1:9000"); err != nil || plan.mainPort != 8701 {
		t.Fatalf("wildcard main: %+v %v", plan, err)
	}
}

// inheritFixture is a keeperClient whose init hands it the given open
// listeners, as the keeper's would.
func inheritFixture(t *testing.T, ls ...net.Listener) *keeperClient {
	t.Helper()
	kc := &keeperClient{}
	for i, l := range ls {
		f, err := l.(*net.TCPListener).File()
		if err != nil {
			t.Fatal(err)
		}
		kc.fds = append(kc.fds, f)
		kc.init.Listeners = append(kc.init.Listeners, listenerInfo{Addr: l.Addr().String(), Fd: i})
	}
	return kc
}

func listenLoopback(t *testing.T) (net.Listener, string) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	return l, l.Addr().String()
}

func closeAllListeners(ls []net.Listener) {
	for _, l := range ls {
		_ = l.Close()
	}
}

func addrsOf(ls []net.Listener) []string {
	var out []string
	for _, l := range ls {
		out = append(out, l.Addr().String())
	}
	return out
}

func TestInheritedListenersTagsMainAndLegacy(t *testing.T) {
	mainL, mainAddr := listenLoopback(t)
	legacyL, legacyAddr := listenLoopback(t)

	// The keeper holds both: each lands on its own side, whatever the order.
	plan, err := parseListenFlags(mainAddr, legacyAddr)
	if err != nil {
		t.Fatal(err)
	}
	m, l, err := inheritFixture(t, legacyL, mainL).inheritedListeners(plan)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(addrsOf(m), []string{mainAddr}) || !slices.Equal(addrsOf(l), []string{legacyAddr}) {
		t.Fatalf("main %v legacy %v", addrsOf(m), addrsOf(l))
	}
	closeAllListeners(append(m, l...))

	// The keeper holds no legacy socket (its bind failed): served without it.
	m, l, err = inheritFixture(t, mainL).inheritedListeners(plan)
	if err != nil {
		t.Fatalf("legacy absent: %v", err)
	}
	if !slices.Equal(addrsOf(m), []string{mainAddr}) || len(l) != 0 {
		t.Fatalf("legacy absent: main %v legacy %v", addrsOf(m), addrsOf(l))
	}
	closeAllListeners(m)

	// A socket neither flag names: the argv and the keeper disagree.
	mainOnly, err := parseListenFlags(mainAddr, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := inheritFixture(t, mainL, legacyL).inheritedListeners(mainOnly); err == nil ||
		!strings.Contains(err.Error(), legacyAddr) || !strings.Contains(err.Error(), "neither") {
		t.Fatalf("stray socket: %v", err)
	}

	// The main socket missing stays fatal, legacy held or not.
	if _, _, err := inheritFixture(t, legacyL).inheritedListeners(plan); err == nil ||
		!strings.Contains(err.Error(), "-listen") {
		t.Fatalf("main missing: %v", err)
	}
}

func TestBindLegacyIsBestEffort(t *testing.T) {
	_, addr := listenLoopback(t) // held: another account's gateway, say
	plan, err := parseListenFlags("127.0.0.1:"+freeLoopbackPort(t), addr)
	if err != nil {
		t.Fatal(err)
	}
	if ls := bindLegacy(plan); len(ls) != 0 {
		closeAllListeners(ls)
		t.Fatalf("bound a port another socket holds: %v", addrsOf(ls))
	}
	free := "127.0.0.1:" + freeLoopbackPort(t)
	if plan, err = parseListenFlags("127.0.0.1:"+freeLoopbackPort(t), free); err != nil {
		t.Fatal(err)
	}
	ls := bindLegacy(plan)
	defer closeAllListeners(ls)
	if !slices.Equal(addrsOf(ls), []string{free}) {
		t.Fatalf("free legacy port: %v", addrsOf(ls))
	}
}

func TestLegacyRedirect(t *testing.T) {
	served := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	h := legacyRedirect(served, 8701)
	nav := map[string]string{"Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "none"}
	with := func(over map[string]string) map[string]string {
		out := map[string]string{}
		for k, v := range nav {
			out[k] = v
		}
		for k, v := range over {
			if v == "" {
				delete(out, k)
			} else {
				out[k] = v
			}
		}
		return out
	}
	cases := []struct {
		name     string
		host     string
		target   string
		headers  map[string]string
		location string // "" = served
	}{
		{"typed URL", "equin.localhost:9000", "/agents/c/x?tab=2&q=a%20b", nav, "http://equin.localhost:8701/agents/c/x?tab=2&q=a%20b"},
		{"same-origin link", "wt.localhost:9000", "/", with(map[string]string{"Sec-Fetch-Site": "same-origin"}), "http://wt.localhost:8701/"},
		{"bare localhost", "localhost:9000", "/home", nav, "http://localhost:8701/home"},
		{"IPv6 literal", "[::1]:9000", "/x", nav, "http://[::1]:8701/x"},
		{"embedded panel", "equin.localhost:9000", "/home/menu-bar?embed=1", nav, ""},
		{"cross-site (OAuth popup)", "equin.localhost:9000", "/settings", with(map[string]string{"Sec-Fetch-Site": "cross-site"}), ""},
		{"same-site frame", "equin.localhost:9000", "/settings", with(map[string]string{"Sec-Fetch-Site": "same-site"}), ""},
		{"no Sec-Fetch-Site (a tool)", "equin.localhost:9000", "/", with(map[string]string{"Sec-Fetch-Site": ""}), ""},
		{"API", "equin.localhost:9000", "/api/auth/callback/google?code=1", nav, ""},
		{"WebSocket path", "equin.localhost:9000", "/ws/notifications", nav, ""},
		{"gateway API", "equin.localhost:9000", "/gateway/identity", nav, ""},
		{"gateway root", "equin.localhost:9000", "/gateway", nav, ""},
		{"a fetch", "equin.localhost:9000", "/agents", with(map[string]string{"Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"}), ""},
		{"an iframe", "equin.localhost:9000", "/agents", with(map[string]string{"Sec-Fetch-Dest": "iframe"}), ""},
		{"no fetch metadata", "equin.localhost:9000", "/agents", map[string]string{}, ""},
		{"a path merely starting with api", "equin.localhost:9000", "/apis", nav, "http://equin.localhost:8701/apis"},
	}
	for _, c := range cases {
		req := httptest.NewRequest(http.MethodGet, "http://"+c.host+c.target, nil)
		req.Host = c.host
		for k, v := range c.headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if c.location == "" {
			if rec.Code != http.StatusTeapot {
				t.Errorf("%s: %d (Location %q), want served", c.name, rec.Code, rec.Header().Get("Location"))
			}
			continue
		}
		if rec.Code != http.StatusPermanentRedirect || rec.Header().Get("Location") != c.location {
			t.Errorf("%s: %d Location %q, want 308 %q", c.name, rec.Code, rec.Header().Get("Location"), c.location)
		}
	}
}

func TestIdentityEndpoint(t *testing.T) {
	p := newTestProxy(t, "")
	get := func() map[string]any {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "http://localhost:8700/gateway/identity", nil)
		rec := httptest.NewRecorder()
		p.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("identity: %d %s", rec.Code, rec.Body)
		}
		var out map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	p.identity = &gatewayIdentity{Product: productName, UID: os.Getuid(), DataDir: "/data", Port: 8700}
	got := get()
	want := map[string]any{"product": "equin", "uid": float64(os.Getuid()), "dataDir": "/data", "port": float64(8700), "legacyListen": nil}
	if !mapsEqual(got, want) {
		t.Fatalf("identity = %v, want %v", got, want)
	}
	if _, ok := got["legacyListen"]; !ok {
		t.Fatal("legacyListen is absent, want null")
	}

	p.identity.LegacyListen = &legacyListenStatus{Addr: "loopback:9000", Held: false}
	got = get()
	if ll, _ := got["legacyListen"].(map[string]any); ll["addr"] != "loopback:9000" || ll["held"] != false {
		t.Fatalf("legacyListen = %v", got["legacyListen"])
	}

	// Owner-only, like every /gateway/* route.
	req := httptest.NewRequest(http.MethodGet, "http://localhost:8700/gateway/identity", nil)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("cross-site identity: %d", rec.Code)
	}
}

func mapsEqual(a, b map[string]any) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if w, ok := b[k]; !ok || w != v {
			return false
		}
	}
	return true
}

func TestChildEnvCarriesTheGatewayPort(t *testing.T) {
	// A starter's own value never reaches a child: the gateway's wins.
	captured, _ := NewChildEnv([]string{"PATH", "EQUIN_*"}, []string{"PATH=/bin", "EQUIN_GATEWAY_PORT=9000"})
	env := runtimeChildEnv(captured, 8702).With()
	var ports []string
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, "EQUIN_GATEWAY_PORT="); ok {
			ports = append(ports, v)
		}
	}
	if !slices.Equal(ports, []string{strconv.Itoa(8702)}) {
		t.Fatalf("EQUIN_GATEWAY_PORT entries %v in %v, want exactly [8702]", ports, env)
	}
	if !slices.Contains(env, "PATH=/bin") {
		t.Fatalf("the captured base was dropped: %v", env)
	}
}
