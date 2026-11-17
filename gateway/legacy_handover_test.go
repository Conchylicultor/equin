package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

// noRedirect is a client that reports a redirect instead of following it.
var noRedirect = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func (f *keeperFixture) identity() gatewayIdentity {
	f.t.Helper()
	body, err := f.get("/gateway/identity")
	if err != nil {
		f.t.Fatal(err)
	}
	var id gatewayIdentity
	if err := json.Unmarshal([]byte(body), &id); err != nil {
		f.t.Fatal(err)
	}
	return id
}

// onLegacy sends a request to the legacy port on the worktree's host —
// a typed-URL navigation when navigate — and answers the status, the
// Location and the body.
func (f *keeperFixture) onLegacy(legacyPort int, path string, navigate bool) (int, string, string) {
	f.t.Helper()
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s", legacyPort, path), nil)
	req.Host = fmt.Sprintf("wt.localhost:%d", legacyPort)
	if navigate {
		req.Header.Set("Sec-Fetch-Mode", "navigate")
		req.Header.Set("Sec-Fetch-Dest", "document")
		req.Header.Set("Sec-Fetch-Site", "none")
	}
	resp, err := noRedirect.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header.Get("Location"), string(b)
}

// checkLegacyServes: the legacy port answers the API like the main one, and
// sends a navigation to the main port.
func (f *keeperFixture) checkLegacyServes(legacyPort int, backendPid string) {
	f.t.Helper()
	if code, _, body := f.onLegacy(legacyPort, "/api/pid", false); code != http.StatusOK || body != backendPid {
		f.t.Fatalf("API on the legacy port: %d %q, want 200 %s", code, body, backendPid)
	}
	code, loc, _ := f.onLegacy(legacyPort, "/agents?x=1", true)
	if want := fmt.Sprintf("http://wt.localhost:%d/agents?x=1", f.port); code != http.StatusPermanentRedirect || loc != want {
		f.t.Fatalf("navigation on the legacy port: %d %q, want 308 %q", code, loc, want)
	}
}

func portOf(t *testing.T, addr string) int {
	t.Helper()
	_, p, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatal(err)
	}
	n, err := strconv.Atoi(p)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// The keeper holds the legacy sockets with the main ones: a handover keeps
// both, and the successor serves the legacy port as its predecessor did.
func TestHandoverCarriesTheLegacyListener(t *testing.T) {
	legacy := "127.0.0.1:" + freeLoopbackPort(t)
	f := startKeeperFixtureWith(t, "-legacy-listen", legacy)
	lp := portOf(t, legacy)
	backendPid, err := f.get("/api/pid")
	if err != nil {
		t.Fatal(err)
	}
	id := f.identity()
	if id.Port != f.port || id.Product != productName || id.LegacyListen == nil || *id.LegacyListen != (legacyListenStatus{Addr: legacy, Held: true}) {
		t.Fatalf("identity: %+v (legacy %+v)", id, id.LegacyListen)
	}
	f.checkLegacyServes(lp, backendPid)

	before := f.status()
	if code, body := f.handover("{}"); code != http.StatusOK {
		t.Fatalf("handover: %d %s", code, body)
	}
	if st := f.status(); st.Pid == before.Pid {
		t.Fatalf("not handed over: %+v", st)
	}
	if id := f.identity(); id.LegacyListen == nil || !id.LegacyListen.Held {
		t.Fatalf("after the handover: legacy %+v", id.LegacyListen)
	}
	f.checkLegacyServes(lp, backendPid)
}

// The legacy port taken (another account's gateway): the gateway serves on
// its own port and says so; a handover whose argv names the legacy port
// succeeds without it, and so does one adding it to a keeper that holds none.
func TestLegacyListenerTakenIsNotFatal(t *testing.T) {
	taken, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer taken.Close()
	legacy := taken.Addr().String()
	f := startKeeperFixtureWith(t, "-legacy-listen", legacy)
	if _, err := f.get("/api/pid"); err != nil {
		t.Fatal(err)
	}
	if id := f.identity(); id.LegacyListen == nil || *id.LegacyListen != (legacyListenStatus{Addr: legacy, Held: false}) {
		t.Fatalf("identity legacy: %+v", id.LegacyListen)
	}
	if code, body := f.handover("{}"); code != http.StatusOK {
		t.Fatalf("handover with the legacy socket missing: %d %s", code, body)
	}
	if id := f.identity(); id.LegacyListen == nil || id.LegacyListen.Held {
		t.Fatalf("after the handover: legacy %+v", id.LegacyListen)
	}
}

// A keeper started with no legacy port, handed an argv that names one: the
// successor serves without it (it is a restart's to bind), never fails.
func TestHandoverAddingALegacyListenerServesWithoutIt(t *testing.T) {
	f := startKeeperFixture(t)
	if id := f.identity(); id.LegacyListen != nil {
		t.Fatalf("no -legacy-listen, identity says %+v", id.LegacyListen)
	}
	legacy := "127.0.0.1:" + freeLoopbackPort(t)
	args, _ := json.Marshal(append(f.status().Args, "-legacy-listen", legacy))
	if code, body := f.handover(`{"args":` + string(args) + `}`); code != http.StatusOK {
		t.Fatalf("handover: %d %s", code, body)
	}
	if id := f.identity(); id.LegacyListen == nil || *id.LegacyListen != (legacyListenStatus{Addr: legacy, Held: false}) {
		t.Fatalf("identity legacy: %+v", id.LegacyListen)
	}
	if !strings.Contains(strings.Join(f.status().Args, " "), "-legacy-listen "+legacy) {
		t.Fatalf("successor args: %v", f.status().Args)
	}
}
