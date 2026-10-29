package main

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
)

// The content host: where equin serves CONTENT (pages that run script but are
// not reviewed app code — an agent-written prototype) as opposed to the APP
// (`<ns>.localhost`). Trust boundaries, Phase 3; design in
// research/2026-10-29-global-content-isolation.md.
//
//	http://<item>.content.localhost:<port>/<ns-label>/api/…
//
//   - <item> is one origin per piece of content (a prototype's id), so two
//     pieces of content cannot read each other's storage or script each other.
//     The gateway reads nothing from it beyond its syntax.
//   - /<ns-label>/ routes the request to that namespace's backend (alias
//     resolved like a Host), so a worktree's content is served by its own code.
//   - content.localhost is a different SITE from every app origin: whatever the
//     content sends to an app origin is cross-site, i.e. anonymous.
//
// The gateway proxies only `/api/…` there, stamped `content` (the backends
// serve only the routes declared as content to it), and refuses everything
// else: the SPA, /ws, /gateway, central routes, Service Worker scripts.
//
// KEEP IN SYNC with CONTENT_HOST_LABEL in
// plugins/infra/plugins/namespace/core/namespace.ts — enforced by the
// `namespace:grammar-in-sync` check, which reads this literal.
const contentHostLabel = "content"

const principalContent = "content"

// contentItemRe is one DNS label: what an item key may be.
var contentItemRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// parseContentHost reports whether a Host is a content host, and its item.
// `content.localhost` alone (no item) is a content host with no item: refused.
func parseContentHost(host string) (item string, ok bool) {
	h := hostOnly(host)
	suffix := "." + contentHostLabel + ".localhost"
	if h == contentHostLabel+".localhost" {
		return "", true
	}
	if !strings.HasSuffix(h, suffix) {
		return "", false
	}
	return strings.TrimSuffix(h, suffix), true
}

// serveContent answers a request on a content host: proxies `/<label>/api/…`
// to that namespace's backend as `/api/…`, stamped `content`, and refuses
// everything else.
func (p *Proxy) serveContent(w http.ResponseWriter, r *http.Request, item string) {
	// The stamp first, whatever happens next: nothing reaching a backend from
	// here may carry a client-sent verdict.
	r.Header.Del(principalHeader)
	r.Header.Set(principalHeader, principalContent)

	if !contentItemRe.MatchString(item) {
		writeContentRefusal(w, r, http.StatusNotFound, "not a content item")
		return
	}
	if isWebSocketUpgrade(r) {
		writeContentRefusal(w, r, http.StatusForbidden, "no socket is served to content")
		return
	}
	// A Service Worker would let one page of content intercept others on its
	// origin; no content needs one.
	if r.Header.Get("Service-Worker") != "" {
		writeContentRefusal(w, r, http.StatusForbidden, "content may not register a Service Worker")
		return
	}
	label, rest, ok := splitContentPath(r.URL.Path)
	if !ok || !strings.HasPrefix(rest, "/api/") {
		writeContentRefusal(w, r, http.StatusNotFound, "only content routes are served here")
		return
	}
	name := label
	if target, ok := hostAliases[label]; ok {
		name = target
	}
	wt := p.reg.Resolve(name)
	if wt == nil {
		writeContentRefusal(w, r, http.StatusNotFound, "unknown namespace: "+label)
		return
	}

	// Set before proxying: the reverse proxy adds the backend's headers to
	// these, so no backend can drop them.
	hdr := w.Header()
	hdr.Set("Content-Security-Policy", "frame-ancestors 'self' "+appFrameAncestors(r.Host))
	hdr.Set("Cross-Origin-Resource-Policy", "same-origin")
	hdr.Set("X-Content-Type-Options", "nosniff")

	r.URL.Path = rest
	r.URL.RawPath = ""
	p.handleHTTP(w, r, wt)
}

// splitContentPath splits `/<label>/rest` into the namespace label and `/rest`.
func splitContentPath(p string) (label, rest string, ok bool) {
	if !strings.HasPrefix(p, "/") {
		return "", "", false
	}
	label, tail, found := strings.Cut(p[1:], "/")
	if !found || label == "" || !nameRegex.MatchString(label) {
		return "", "", false
	}
	return label, "/" + tail, true
}

// appFrameAncestors: the app origins on this gateway, the only pages that may
// frame content (a wildcard source covers every subdomain depth).
func appFrameAncestors(host string) string {
	port := ""
	h := host
	if strings.HasPrefix(h, "[") {
		if end := strings.Index(h, "]"); end >= 0 {
			h = h[end+1:]
		}
	}
	if i := strings.LastIndex(h, ":"); i >= 0 {
		port = h[i:]
	}
	return "http://*.localhost" + port
}

func writeContentRefusal(w http.ResponseWriter, r *http.Request, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"reason":  "content-refused",
		"route":   r.Method + " " + r.URL.Path,
		"message": message,
	})
}
