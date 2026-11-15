package main

import (
	"encoding/json"
	"net/http"
	"strings"
)

// principalHeader carries the verdict of principalOf to the backend. The
// gateway deletes any client-sent value and stamps its own, on the HTTP proxy
// and the WebSocket replay alike. The TS side (framework/principal) names the
// same header in lowercase; a check keeps the two in sync.
const principalHeader = "X-Equin-Principal"

// principalStampedFlag is the bare argv flag backendLaunch hands every backend
// (central included): this gateway stamps principalHeader on every request it
// proxies, so the backend may refuse a request without it. The TS side
// (framework/principal's PRINCIPAL_STAMPED_FLAG) reads the same flag; the
// principal:header-in-sync check pins the two.
const principalStampedFlag = "--principal-stamped"

const (
	principalOwner     = "owner"
	principalAnonymous = "anonymous"
	// principalVisitor is anyone who reached this gateway through a deployed
	// site's public edge (Caddy): a stranger on the internet, on the site's
	// own origin. Never the owner — whatever headers they send — because every
	// header but the ones the edge adds is theirs to forge.
	principalVisitor = "visitor"
	// principalContent is every request on the content host (content.go).
	principalContent = "content"
)

// forwardingHeaders are the headers a reverse proxy in front of this gateway
// adds (Caddy's reverse_proxy sets all three, replacing any client value). A
// request carrying one came through a proxy, not from a tool on this machine:
// a local tool (the CLI, MCP, the box's own health curl) dials the gateway
// straight and sends none, and the hop between two generations of this
// gateway (handover.go) adds none.
var forwardingHeaders = []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "Forwarded"}

// cameThroughEdge reports whether r reached this gateway through a public
// edge: its Host is one of the deployed site's public hostnames, or a proxy
// in front of the gateway forwarded it. Either alone suffices — fail closed.
func cameThroughEdge(r *http.Request, publicHosts map[string]bool) bool {
	if publicHosts[hostOnly(r.Host)] {
		return true
	}
	for _, name := range forwardingHeaders {
		if _, ok := r.Header[name]; ok {
			return true
		}
	}
	return false
}

// hostOnly strips the port, IPv6 brackets, case and trailing dot off a Host.
func hostOnly(host string) string {
	h := host
	if strings.HasPrefix(h, "[") {
		if end := strings.Index(h, "]"); end >= 0 {
			h = h[1:end]
		}
	} else if i := strings.LastIndex(h, ":"); i > 0 {
		h = h[:i]
	}
	return strings.TrimSuffix(strings.ToLower(h), ".")
}

// parsePublicHosts reads the -public-hosts list (comma-separated hostnames)
// into the set principalOf tests a Host against, normalised like hostOnly.
func parsePublicHosts(list string) map[string]bool {
	set := map[string]bool{}
	for _, h := range strings.Split(list, ",") {
		if h = hostOnly(strings.TrimSpace(h)); h != "" {
			set[h] = true
		}
	}
	return set
}

func isLoopbackLiteral(h string) bool {
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

// principalOf says who a request is: "owner" (the person at this machine's
// browser, or a local tool), "visitor" (anyone who came through a deployed
// site's public edge) or "anonymous" (a foreign page, a rebound DNS name).
// Same-origin, not same-site.
//
//  1. Host is not an equin host -> anonymous. DNS rebinding: evil.com
//     resolved to 127.0.0.1 is same-origin with itself. A deployed site's own
//     public hostnames (-public-hosts, forwarded unchanged by Caddy) count as
//     equin hosts.
//  2. Came through the edge (a public Host, or any forwarding header) ->
//     visitor. The rules below read headers a browser cannot forge, but a
//     stranger's curl can send any of them (or none: "a local tool"); only
//     the owner's own machine — never the internet — can be the owner. The
//     owner of a deployed site reaches it on the box (SSH), not through Caddy.
//  3. Sec-Fetch-Site same-origin / none (typed URL, bookmark) -> owner.
//  4. No Sec-Fetch-Site and no Origin -> owner: a local tool (CLI, MCP, curl).
//     Browsers always send Sec-Fetch-Site and cannot suppress it.
//  5. No Sec-Fetch-Site, Origin == http(s)://<Host> -> owner (older browsers).
//  6. Anything else -> anonymous: cross-site, same-site (a sibling namespace
//     is not the page's own origin), Origin: null.
func principalOf(r *http.Request, publicHosts map[string]bool) string {
	h := hostOnly(r.Host)
	if parseWorktree(r.Host) == "" && !isLoopbackLiteral(h) && !publicHosts[h] {
		return principalAnonymous
	}
	if cameThroughEdge(r, publicHosts) {
		return principalVisitor
	}
	site := r.Header.Get("Sec-Fetch-Site")
	switch site {
	case "same-origin", "none":
		return principalOwner
	case "":
		origin := r.Header.Get("Origin")
		if origin == "" || strings.EqualFold(origin, "http://"+r.Host) || strings.EqualFold(origin, "https://"+r.Host) {
			return principalOwner
		}
	}
	return principalAnonymous
}

// gatewayAPIRefused reports whether the gateway refuses a request to its own
// control API (/gateway/*) from this principal: everyone but the owner, every
// method. The API stops, restarts and holds backends, starts deploys and
// lists the machine's checkouts; no page calls it, and no caller but the
// owner's own tools has any business reading it.
func gatewayAPIRefused(principal string) bool {
	return principal != principalOwner
}

// writeCrossSiteRefusal answers 403 cross-site-refused, before anything ran.
func writeCrossSiteRefusal(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"reason":  "cross-site-refused",
		"route":   r.Method + " " + r.URL.Path,
		"message": "A request from another site is not the owner; equin refused it before it ran.",
	})
}
