package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// Proxy is the gateway's top-level http.Handler. It dispatches every request
// to one of: gateway API, static file, backend HTTP proxy, or backend WS proxy.
type Proxy struct {
	reg    *Registry
	routes *CentralRoutesStore
	sup    *Supervisor
	// defaultNamespace is the fallback worktree for requests that resolve to no
	// namespace (bare localhost, no central-route match). Empty in dev/multi-app
	// mode (such requests 404); set to the single app's name in a packaged
	// single-app build (desktop/Tauri, single-origin web) so a webview with no
	// `<name>.localhost` subdomain still reaches the backend.
	defaultNamespace string
}

func NewProxy(reg *Registry, routes *CentralRoutesStore, sup *Supervisor, defaultNamespace string) *Proxy {
	return &Proxy{reg: reg, routes: routes, sup: sup, defaultNamespace: defaultNamespace}
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	worktreeName := parseWorktree(r.Host)

	// /gateway/* is reserved on every host, including the no-subdomain root.
	if strings.HasPrefix(r.URL.Path, "/gateway/") {
		p.handleGatewayAPI(w, r)
		return
	}

	// Central routing manifest: paths declared by central plugins are forwarded
	// to the singleton central backend regardless of which host the request
	// arrived on (including bare localhost). The manifest is written by the
	// central runtime itself on boot, from the routes it registered
	// (central-core/bin/routes-manifest.ts), to ~/.singularity/state/gateway/central-routes.json and watched
	// for changes — see central_routes.go. Auth's `/api/auth/{start,callback}/*`
	// callbacks (which Google requires on bare-localhost) reach central through
	// this same mechanism since auth migrated to the central runtime.
	if backend := p.routes.Get().Match(r.URL.Path); backend != "" {
		worktreeName = backend
	}

	// Single-app fallback: a packaged build sets a default namespace so a
	// subdomain-less request (a desktop webview at bare localhost / tauri://,
	// or Windows where *.localhost does not resolve) still routes to the one
	// app. Lowest precedence — an explicit subdomain or a central route wins.
	// Empty default ⇒ today's behavior (such requests 404), so dev is unaffected.
	if worktreeName == "" && p.defaultNamespace != "" {
		worktreeName = p.defaultNamespace
	}

	if worktreeName == "" {
		http.Error(w, "Singularity gateway. Use <name>.localhost.", http.StatusNotFound)
		return
	}

	// Resolve, not Get: a worktree whose spec.json is on disk but which the
	// fsnotify watch never registered (FD pressure) is loaded on demand here, so
	// the request is served instead of 404ing until the next reconcile tick.
	wt := p.reg.Resolve(worktreeName)
	if wt == nil {
		http.Error(w, "unknown worktree: "+worktreeName, http.StatusNotFound)
		return
	}

	if isBackendPath(r.URL.Path) {
		if isWebSocketUpgrade(r) {
			p.handleWebSocket(w, r, wt)
		} else {
			p.handleHTTP(w, r, wt)
		}
		return
	}

	p.handleStatic(w, r, wt)
}

// ─── route handlers ──────────────────────────────────────────

// indexURL is the one URL in a dist whose bytes change from build to build.
// Both places that serve the SPA shell spell it through this constant so they
// cannot drift apart.
const indexURL = "/index.html"

// serveIndex serves the SPA shell, which must never be replayed from a browser
// cache without asking us first.
//
// Every other file in a dist is content-addressed — its hash is in its path —
// so a stale copy is simply the file that URL names. index.html is the sole
// exception: one URL, new bytes on every build. Served with no Cache-Control at
// all (what http.ServeFile does on its own), a browser falls back to heuristic
// freshness — roughly a tenth of the document's age at fetch time — and replays
// its stored copy for that window without contacting us. A tab opened after a
// build then boots the PREVIOUS bundle, whose content-addressed URLs all still
// resolve, so it runs old code faithfully and only the in-app "Server updated"
// reload prompt reveals it.
//
// no-cache lets the browser keep storing the file but forces revalidation, which
// an unchanged dist answers with a bodiless 304.
func serveIndex(w http.ResponseWriter, r *http.Request, indexPath string) {
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, indexPath)
}

// handleStatic serves a file from the worktree's web/dist directory. Any path
// that doesn't match an existing file falls back to index.html so the SPA
// client router can handle it (including paths with extensions like /file/foo.ts)
// — except /artifacts/*, which never falls back (see below).
func (p *Proxy) handleStatic(w http.ResponseWriter, r *http.Request, wt *Worktree) {
	webDir := wt.Spec().Web
	if webDir == "" {
		// Headless backend (e.g. central) — no static bundle to serve.
		http.NotFound(w, r)
		return
	}
	upath := path.Clean(r.URL.Path)
	if upath == "/" || upath == "." {
		upath = indexURL
	}
	full := filepath.Join(webDir, upath)

	info, err := os.Stat(full)
	if err == nil && !info.IsDir() {
		if upath == indexURL {
			serveIndex(w, r, full)
			return
		}
		http.ServeFile(w, r, full)
		return
	}
	// /artifacts/* URLs are content-addressed module files (import-map targets),
	// never SPA routes: serving index.html for a miss — including a dangling
	// store symlink — would hand the module loader an HTML document and surface
	// as a cryptic parse error. An honest 404 instead.
	if strings.HasPrefix(upath, "/artifacts/") {
		http.NotFound(w, r)
		return
	}
	// File not found or is a directory → SPA fallback regardless of extension.
	// The client router decides whether it's a real route or a 404.
	indexPath := filepath.Join(webDir, indexURL)
	if _, ierr := os.Stat(indexPath); ierr == nil {
		serveIndex(w, r, indexPath)
		return
	}
	http.NotFound(w, r)
}

// handleHTTP cold-starts the backend if needed and proxies the request. The
// request is counted against the serving backend for the duration so a hot
// restart drains it before terminating the process (avoids mid-request 502s).
func (p *Proxy) handleHTTP(w http.ResponseWriter, r *http.Request, wt *Worktree) {
	bk, err := wt.Ensure(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	bk.incHTTP()
	defer bk.decHTTP()
	bk.proxy.ServeHTTP(w, r)
	wt.TouchBackend()
}

// handleWebSocket cold-starts the backend, hijacks the client connection, and
// shuttles bytes both ways until either side closes. The WebSocket connection
// is pinned to the backend that was active at dial time — a hot restart swaps
// new requests to the new backend without disturbing open connections.
func (p *Proxy) handleWebSocket(w http.ResponseWriter, r *http.Request, wt *Worktree) {
	bk, err := wt.Ensure(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if bk == nil {
		http.Error(w, "backend socket unavailable", http.StatusBadGateway)
		return
	}

	dialCtx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	var d net.Dialer
	backendConn, err := d.DialContext(dialCtx, "unix", bk.socketPath)
	if err != nil {
		http.Error(w, "backend dial: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer backendConn.Close()

	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return
	}
	clientConn, _, err := hj.Hijack()
	if err != nil {
		return
	}
	defer clientConn.Close()

	// Forward the original request line + headers to the backend over UDS.
	// Bun doesn't validate Host against the listener type; leaving the
	// incoming Host intact is fine and matches what backends saw under TCP.
	if err := r.Write(backendConn); err != nil {
		return
	}

	wt.TouchBackend()
	bk.incWS()
	defer bk.decWS()

	errc := make(chan error, 2)
	go func() {
		_, e := io.Copy(backendConn, clientConn)
		errc <- e
	}()
	go func() {
		_, e := io.Copy(clientConn, backendConn)
		errc <- e
	}()
	<-errc
}

// handleGatewayAPI serves /gateway/* endpoints.
func (p *Proxy) handleGatewayAPI(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/gateway/services" && r.Method == http.MethodGet {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(p.sup.List())
		return
	}

	const servicesPrefix = "/gateway/services/"
	if strings.HasPrefix(r.URL.Path, servicesPrefix) && r.Method == http.MethodGet {
		name := strings.TrimPrefix(r.URL.Path, servicesPrefix)
		name = strings.TrimSuffix(name, "/status")
		snap := p.sup.Get(name)
		if snap == nil {
			http.Error(w, "unknown service: "+name, http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(snap)
		return
	}

	if r.URL.Path == "/gateway/worktrees" && r.Method == http.MethodGet {
		list := p.reg.List()
		out := make([]WorktreeStatus, 0, len(list))
		for _, wt := range list {
			out = append(out, wt.Snapshot())
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
		return
	}

	const prefix = "/gateway/worktrees/"
	if strings.HasPrefix(r.URL.Path, prefix) {
		rest := strings.TrimPrefix(r.URL.Path, prefix)
		slash := strings.Index(rest, "/")
		if slash <= 0 {
			http.NotFound(w, r)
			return
		}
		name := rest[:slash]
		action := rest[slash+1:]
		if name == "" || strings.Contains(name, "/") {
			http.NotFound(w, r)
			return
		}
		wt := p.reg.Resolve(name)
		if wt == nil {
			http.Error(w, "unknown worktree: "+name, http.StatusNotFound)
			return
		}

		switch {
		case action == "restart" && r.Method == http.MethodPost:
			ctx := r.Context()
			// The caller is a build that just rewrote this worktree's spec.json
			// (a new dist path, a new server argv). Adopt it BEFORE restarting:
			// Restart snapshots wt.Spec() to spawn with, so refreshing after
			// would apply the new argv only on some later respawn, and the
			// build would report "deployed" against the previous spec.
			p.reg.RefreshSpec(name)
			snap := wt.Snapshot()
			switch snap.State {
			case "running", "restarting":
				if err := wt.Restart(ctx); err != nil {
					http.Error(w, "hot restart failed: "+err.Error(), http.StatusInternalServerError)
					return
				}
			case "idle", "broken":
				if _, err := wt.Ensure(ctx); err != nil {
					http.Error(w, "cold start failed: "+err.Error(), http.StatusInternalServerError)
					return
				}
			default:
				http.Error(w, "backend is "+snap.State+"; retry shortly", http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"restarted":true}` + "\n"))
			return

		case action == "stop" && r.Method == http.MethodPost:
			// The idle sweeper's teardown, on demand: the backend exits, the
			// worktree stays registered at idle, and the next request
			// cold-starts it (the cold-start benchmark's reset step). Same
			// stop path and the same pinned rule as Registry.Sweep.
			if wt.Pinned() {
				http.Error(w, name+" is pinned and is never stopped", http.StatusConflict)
				return
			}
			if err := wt.Stop(r.Context()); err != nil {
				http.Error(w, "stop failed: "+err.Error(), http.StatusInternalServerError)
				return
			}
			snap := wt.Snapshot()
			// Stop returns at once when another Stop is already tearing the
			// backend down; it has not exited yet, so do not report it stopped.
			if snap.State == StateStopping.String() {
				http.Error(w, "backend is stopping; retry shortly", http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(snap)
			return

		case action == "logs" && r.Method == http.MethodGet:
			streamBackendLogs(w, r, wt)
			return
		}
	}

	http.NotFound(w, r)
}

// streamBackendLogs serves a Server-Sent Events stream of a worktree's
// backend stdout/stderr. On connect, one `event: history` message delivers
// the current ring buffer contents; each subsequent log line is sent as
// `event: entry`. The stream ends when the client disconnects.
func streamBackendLogs(w http.ResponseWriter, r *http.Request, wt *Worktree) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	snapshot, ch, unsub := wt.logBuf.Subscribe()
	defer unsub()

	historyPayload, err := json.Marshal(map[string]any{"entries": snapshot})
	if err != nil {
		return
	}
	if _, err := fmt.Fprintf(w, "event: history\ndata: %s\n\n", historyPayload); err != nil {
		return
	}
	flusher.Flush()

	pingTick := time.NewTicker(25 * time.Second)
	defer pingTick.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case e, ok := <-ch:
			if !ok {
				return
			}
			payload, err := json.Marshal(e)
			if err != nil {
				continue
			}
			if _, err := fmt.Fprintf(w, "event: entry\ndata: %s\n\n", payload); err != nil {
				return
			}
			flusher.Flush()
		case <-pingTick.C:
			if _, err := fmt.Fprintf(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// ─── pure helpers ────────────────────────────────────────────

// parseWorktree extracts the namespace from a Host header.
// Returns "" for loopback hostnames or anything not matching <name>.localhost.
// <name> may carry dots (`sonata.att-XXX`); see nameRegex in registry.go.
func parseWorktree(host string) string {
	h := host
	// IPv6 with brackets: [::1]:9000
	if strings.HasPrefix(h, "[") {
		if end := strings.Index(h, "]"); end >= 0 {
			h = h[1:end]
		}
	} else if i := strings.LastIndex(h, ":"); i > 0 {
		// Strip port for v4 / hostnames
		h = h[:i]
	}
	h = strings.ToLower(h)
	h = strings.TrimSuffix(h, ".")
	switch h {
	case "localhost", "127.0.0.1", "::1":
		return ""
	}
	if !strings.HasSuffix(h, ".localhost") {
		return ""
	}
	// Multi-label names are legal: a namespace is `<composition>.<checkout>`
	// (`sonata.att-XXX.localhost`), with both sentinels elided so today's
	// single-label URLs are unchanged. The name is returned verbatim and
	// validated by `nameRegex` in Resolve/loadFile — the gateway never
	// decomposes it. The loopback short-circuit above must stay ahead of this,
	// since `127.0.0.1` and `::1` contain dots and colons of their own.
	return strings.TrimSuffix(h, ".localhost")
}

func isBackendPath(p string) bool {
	return strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/ws/")
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}
