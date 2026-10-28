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
)

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
// browser, or a local tool) or "anonymous" (a foreign page, a rebound DNS
// name). Same-origin, not same-site.
//
//  1. Host is not an equin host -> anonymous. DNS rebinding: evil.com
//     resolved to 127.0.0.1 is same-origin with itself. A deployed site's own
//     public hostnames (-public-hosts, forwarded unchanged by Caddy) count as
//     equin hosts.
//  2. Sec-Fetch-Site same-origin / none (typed URL, bookmark) -> owner.
//  3. No Sec-Fetch-Site and no Origin -> owner: a local tool (CLI, MCP, curl).
//     Browsers always send Sec-Fetch-Site and cannot suppress it.
//  4. No Sec-Fetch-Site, Origin == http(s)://<Host> -> owner (older browsers;
//     https because a deployed site sits behind Caddy's TLS).
//  5. Anything else -> anonymous: cross-site, same-site (a sibling namespace
//     is not the page's own origin), Origin: null.
func principalOf(r *http.Request, publicHosts map[string]bool) string {
	h := hostOnly(r.Host)
	if parseWorktree(r.Host) == "" && !isLoopbackLiteral(h) && !publicHosts[h] {
		return principalAnonymous
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
