package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
)

// ─── what the gateway listens on ─────────────────────────────
//
// -listen is the browser port: required, no default. The port is chosen per
// account by `./equin start` (the first free one of a small range;
// plugins/infra/plugins/launcher/plugins/gateway-port owns the choice)
// and handed down as this flag — a default here would be a second copy of
// that choice, free to drift from it.
//
// -legacy-listen is the port an install moved off (the old fixed port, while
// it migrates): served exactly like the main one, except that a top-level
// document navigation is sent to the main port (legacyRedirect). Its bind is
// best effort — another account's gateway may hold that port — so a failure
// is a warning, reported by GET /gateway/identity, never fatal. Design:
// research/2026-11-17-global-gateway-port-v2.md § 4.

// listenPlan is -listen and -legacy-listen, parsed and checked.
type listenPlan struct {
	mainSpec string // the -listen value
	main     []listenAddr
	mainPort int
	// legacySpec is the -legacy-listen value ("" for none); legacy its
	// addresses (nil for none).
	legacySpec string
	legacy     []listenAddr
}

// errListenRequired names the fix: the usual way to hit it is a hand run.
var errListenRequired = errors.New("-listen is required — start the gateway with ./equin start, which passes this " +
	"account's port; to hand-run it, pass e.g. -listen loopback:<port>")

// parseListenFlags checks both flags: -listen present, each a host:port with
// a real port, and the legacy port not the main one.
func parseListenFlags(listen, legacy string) (listenPlan, error) {
	if strings.TrimSpace(listen) == "" {
		return listenPlan{}, errListenRequired
	}
	mainPort, err := listenPort("-listen", listen)
	if err != nil {
		return listenPlan{}, err
	}
	plan := listenPlan{mainSpec: listen, main: listenAddrs(listen), mainPort: mainPort}
	if legacy == "" {
		return plan, nil
	}
	legacyPort, err := listenPort("-legacy-listen", legacy)
	if err != nil {
		return listenPlan{}, err
	}
	if legacyPort == mainPort {
		return listenPlan{}, fmt.Errorf("-legacy-listen %q names the port -listen %q already serves", legacy, listen)
	}
	plan.legacySpec = legacy
	plan.legacy = listenAddrs(legacy)
	return plan, nil
}

// listenPort is the port a listen flag names: 1..65535 (0 — "any port" —
// would leave nothing to tell a child or a browser).
func listenPort(flagName, s string) (int, error) {
	_, p, err := net.SplitHostPort(s)
	if err != nil {
		return 0, fmt.Errorf("%s %q: %w (want loopback:<port>, <host>:<port> or :<port>)", flagName, s, err)
	}
	port, err := strconv.Atoi(p)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("%s %q: the port must be a number in 1..65535", flagName, s)
	}
	return port, nil
}

// bindLegacy binds the legacy addresses, all or none (listenAll). Never
// fatal: on a failure it warns and returns none.
func bindLegacy(plan listenPlan) []net.Listener {
	if plan.legacy == nil {
		return nil
	}
	ls, err := listenAll(plan.legacy)
	if err != nil {
		slog.Warn("legacy listener not bound; serving on -listen only", "legacy_listen", plan.legacySpec, "err", err)
		return nil
	}
	return ls
}

// legacyListenStatus is -legacy-listen as GET /gateway/identity reports it:
// the flag's value, and whether this gateway holds its sockets.
type legacyListenStatus struct {
	Addr string `json:"addr"`
	Held bool   `json:"held"`
}

// ─── the legacy port's one difference: navigations move ─────

// legacyRedirect is the legacy listeners' handler: next, except that a
// top-level document navigation is answered 308 to the same host name, path
// and query on the main port — bookmarks and typed URLs move, while
// everything a running client holds on to (an agent's EQUIN_PARENT_URL, an
// open tab's API calls and WebSockets, an embedded panel) keeps working.
func legacyRedirect(next http.Handler, mainPort int) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !movesToMainPort(r) {
			next.ServeHTTP(w, r)
			return
		}
		http.Redirect(w, r, mainPortURL(r, mainPort), http.StatusPermanentRedirect)
	})
}

// movesToMainPort: a top-level document navigation the user made
// (Sec-Fetch-Site none / same-origin), and none of the exemptions — an
// embedded document (?embed=1: the tray panel, the extension's frame), a
// cross-site one (an OAuth popup, a foreign frame; an absent Sec-Fetch-Site
// is a tool, not a browser), or the gateway's API, the backends' API or a
// WebSocket path.
func movesToMainPort(r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Mode") != "navigate" || r.Header.Get("Sec-Fetch-Dest") != "document" {
		return false
	}
	switch r.Header.Get("Sec-Fetch-Site") {
	case "none", "same-origin":
	default:
		return false
	}
	for _, p := range []string{"/gateway", "/api", "/ws"} {
		if r.URL.Path == p || strings.HasPrefix(r.URL.Path, p+"/") {
			return false
		}
	}
	return r.URL.Query().Get("embed") != "1"
}

// mainPortURL is r's URL on the main port: the request's own host name, its
// port swapped, path and query kept.
func mainPortURL(r *http.Request, mainPort int) string {
	u := url.URL{
		Scheme:   "http",
		Host:     net.JoinHostPort(hostOnly(r.Host), strconv.Itoa(mainPort)),
		Path:     r.URL.Path,
		RawPath:  r.URL.RawPath,
		RawQuery: r.URL.RawQuery,
	}
	if r.TLS != nil {
		u.Scheme = "https"
	}
	return u.String()
}

// ─── the servers over every listener ─────────────────────────

// serverSet is the gateway's http.Servers — the main one, and the legacy one
// when it holds legacy sockets — shut down and closed together.
type serverSet []*http.Server

// Shutdown drains every server at once, within ctx.
func (s serverSet) Shutdown(ctx context.Context) error {
	errs := make([]error, len(s))
	var wg sync.WaitGroup
	for i, srv := range s {
		wg.Add(1)
		go func() { defer wg.Done(); errs[i] = srv.Shutdown(ctx) }()
	}
	wg.Wait()
	return errors.Join(errs...)
}

// Close closes every server's listeners and connections.
func (s serverSet) Close() error {
	var errs []error
	for _, srv := range s {
		errs = append(errs, srv.Close())
	}
	return errors.Join(errs...)
}
