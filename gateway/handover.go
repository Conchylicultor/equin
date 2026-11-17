package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ─── handing this generation over to a successor ───────────────
//
// POST /gateway/handover asks the keeper to replace this generation. In order:
//
//  1. Freeze: no lifecycle transition (a spawn, a restart, a stop, a deploy
//     run) starts any more, and the ones in flight are waited out. This
//     generation keeps SERVING the whole time — a request to a running
//     backend never waits on any of this.
//  2. State: what the successor needs that the keeper does not hold (holds,
//     broken boots, idle clocks, each backend's ready time, main deploy's
//     pending edges) goes to the keeper with the request.
//  3. The keeper starts the successor over the same listening sockets and the
//     same children. Once it serves, both generations accept; then this one
//     closes its copies of the listeners (the sockets stay open — the keeper
//     and the successor hold them), so the kernel hands every new connection
//     to the successor.
//  4. Drain: requests already in flight here finish here (their backends are
//     alive — the successor adopted them). A request that needs a lifecycle
//     change, or arrives on a connection still open to this generation, is
//     forwarded to the successor. WebSockets are closed: their clients
//     reconnect to the successor, to the same running backend.
//  5. Exit, without stopping a backend.
//
// Any failure before the successor serves leaves this generation exactly as
// it was: unfrozen, serving, nothing changed.

// errHandedOver: this generation was replaced; the request belongs to the
// successor (Proxy.forwardToSuccessor).
var errHandedOver = errors.New("this gateway handed over to its successor")

// lifecycleGate counts lifecycle transitions in flight and can freeze them.
// A nil gate (a gateway with no keeper, a test) admits everything.
type lifecycleGate struct {
	mu       sync.Mutex
	frozen   bool
	replaced bool
	inflight int
	// changed is closed and replaced on every state change: waiters re-check.
	changed chan struct{}
}

func newLifecycleGate() *lifecycleGate {
	return &lifecycleGate{changed: make(chan struct{})}
}

func (g *lifecycleGate) broadcastLocked() {
	close(g.changed)
	g.changed = make(chan struct{})
}

// enter admits one lifecycle transition; release ends it. While frozen it
// waits; once replaced it answers errHandedOver.
func (g *lifecycleGate) enter(ctx context.Context) (release func(), err error) {
	if g == nil {
		return func() {}, nil
	}
	for {
		g.mu.Lock()
		if g.replaced {
			g.mu.Unlock()
			return nil, errHandedOver
		}
		if !g.frozen {
			g.inflight++
			g.mu.Unlock()
			var once sync.Once
			return func() {
				once.Do(func() {
					g.mu.Lock()
					g.inflight--
					g.broadcastLocked()
					g.mu.Unlock()
				})
			}, nil
		}
		ch := g.changed
		g.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// open reports whether a transition would be admitted now (the idle sweeper
// and the deploy timer skip rather than wait).
func (g *lifecycleGate) open() bool {
	if g == nil {
		return true
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return !g.frozen && !g.replaced
}

// freeze stops new transitions and waits for the ones in flight. On ctx's end
// it unfreezes and returns the error.
func (g *lifecycleGate) freeze(ctx context.Context) error {
	g.mu.Lock()
	if g.frozen || g.replaced {
		g.mu.Unlock()
		return errors.New("a handover is already in progress")
	}
	g.frozen = true
	g.broadcastLocked()
	for g.inflight > 0 {
		ch := g.changed
		g.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			g.unfreeze()
			return fmt.Errorf("lifecycle transitions still in flight: %w", ctx.Err())
		}
		g.mu.Lock()
	}
	g.mu.Unlock()
	return nil
}

func (g *lifecycleGate) unfreeze() {
	g.mu.Lock()
	g.frozen = false
	g.broadcastLocked()
	g.mu.Unlock()
}

func (g *lifecycleGate) markReplaced() {
	g.mu.Lock()
	g.replaced = true
	g.broadcastLocked()
	g.mu.Unlock()
}

func (g *lifecycleGate) isReplaced() bool {
	if g == nil {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.replaced
}

// ─── the state a successor is handed ───────────────────────────

type generationState struct {
	Worktrees []worktreeState `json:"worktrees"`
	Deploy    *deployState    `json:"deploy,omitempty"`
}

type worktreeState struct {
	Name         string `json:"name"`
	Held         bool   `json:"held,omitempty"`
	BrokenErr    string `json:"brokenErr,omitempty"`
	BrokenUntil  int64  `json:"brokenUntil,omitempty"`
	LastActivity int64  `json:"lastActivity,omitempty"`
	// Running backend: its pid and when it passed readiness.
	Pid     int   `json:"pid,omitempty"`
	ReadyAt int64 `json:"readyAt,omitempty"`
}

type deployState struct {
	Ref     string   `json:"ref"`
	Pending []string `json:"pending,omitempty"`
}

// exportState reads what the successor needs. Called frozen: every worktree
// is idle, running or broken.
func exportState(reg *Registry, d *mainDeployer) generationState {
	var st generationState
	for _, wt := range reg.List() {
		ws := worktreeState{Name: wt.Name}
		wt.mu.Lock()
		ws.LastActivity = wt.lastActivity.UnixMilli()
		switch p := wt.phase.(type) {
		case phaseIdle:
			ws.Held = p.held
		case phaseBroken:
			if p.err != nil {
				ws.BrokenErr = p.err.Error()
			}
			ws.BrokenUntil = p.until.UnixMilli()
		case phaseRunning:
			ws.Pid = backendPID(p.bk)
			ws.ReadyAt = p.bk.readyAt.Load()
		}
		wt.mu.Unlock()
		if ws.Held || ws.BrokenErr != "" || ws.Pid != 0 {
			st.Worktrees = append(st.Worktrees, ws)
		}
	}
	if d != nil {
		st.Deploy = d.exportState()
	}
	return st
}

// ─── the route ─────────────────────────────────────────────────

// handover is a generation's handover machinery. nil when this gateway has no
// keeper (then the route answers 404, as on a gateway that predates it, and
// a caller restarts the service instead).
type handover struct {
	kc      *keeperClient
	gate    *lifecycleGate
	reg     *Registry
	sup     *Supervisor
	deploy  *mainDeployer
	started time.Time

	// replacedCh closes once the successor serves: main drains and exits.
	replacedCh chan struct{}
	once       sync.Once
	// successorAddr is where a request this generation no longer owns is
	// forwarded: the shared listening socket, which only the successor
	// accepts on once this generation's copies are closed.
	successorAddr string
	forward       *httputil.ReverseProxy

	wsMu sync.Mutex
	ws   map[net.Conn]struct{}

	// listeners: this generation's copies of the shared listening sockets,
	// closed when it is replaced. conns: client connections it still holds.
	listeners []net.Listener
	connMu    sync.Mutex
	conns     map[net.Conn]struct{}
	connsZero chan struct{} // signalled whenever conns drops to zero
}

// trackConn is http.Server.ConnState: which client connections this
// generation still holds (a hijacked one is the WebSocket set's).
func (h *handover) trackConn(c net.Conn, st http.ConnState) {
	h.connMu.Lock()
	defer h.connMu.Unlock()
	switch st {
	case http.StateNew:
		h.conns[c] = struct{}{}
	case http.StateHijacked, http.StateClosed:
		delete(h.conns, c)
		if len(h.conns) == 0 {
			select {
			case h.connsZero <- struct{}{}:
			default:
			}
		}
	}
}

func (h *handover) openConns() int {
	h.connMu.Lock()
	defer h.connMu.Unlock()
	return len(h.conns)
}

// drain is a replaced generation's last act: close its copies of the
// listeners (only the successor accepts from now), then wait — within
// budget — for every client connection it still holds to close. It never
// closes an idle keep-alive connection itself: a client may be writing a
// request on it at that very moment (an EOF a POST is not retried after).
// Each later request on one is forwarded with `Connection: close`, so the
// connection ends after it and the client reconnects to the successor; one
// that stays idle is closed by the client's own idle timeout (Go's 90 s,
// Caddy's 2 min). Past budget the rest are closed.
func (h *handover) drain(ctx context.Context, srv serverSet, budget time.Duration) {
	for _, l := range h.listeners {
		_ = l.Close()
	}
	h.onListenersClosed()
	started := time.Now()
	deadline := time.NewTimer(budget)
	defer deadline.Stop()
	for h.openConns() > 0 {
		select {
		case <-h.connsZero:
		case <-deadline.C:
			slog.Warn("handover: drain budget spent; closing the connections still open", "open", h.openConns(), "budget", budget)
			_ = srv.Close()
			return
		case <-ctx.Done():
			_ = srv.Close()
			return
		}
	}
	slog.Info("handover: every connection closed; exiting", "drained_in", time.Since(started))
	_ = srv.Close()
}

func newHandover(kc *keeperClient, gate *lifecycleGate, reg *Registry, sup *Supervisor, listenAddr string) *handover {
	h := &handover{kc: kc, gate: gate, reg: reg, sup: sup, started: time.Now(), replacedCh: make(chan struct{}), ws: map[net.Conn]struct{}{},
		conns: map[net.Conn]struct{}{}, connsZero: make(chan struct{}, 1)}
	h.successorAddr = dialAddrOf(listenAddr)
	target := &url.URL{Scheme: "http", Host: h.successorAddr}
	h.forward = &httputil.ReverseProxy{
		Director: func(r *http.Request) {
			r.URL.Scheme = target.Scheme
			r.URL.Host = target.Host
			// r.Host (the visitor's) is kept: the successor routes on it.
			// Forwarded as the caller sent it: a hop between two generations
			// of the same gateway is no proxy, so no X-Forwarded-For is added
			// (one the caller carried — a front proxy's — is kept).
			if _, ok := r.Header["X-Forwarded-For"]; !ok {
				r.Header["X-Forwarded-For"] = nil
			}
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			slog.Error("handover: forwarding to the successor failed", "path", r.URL.Path, "err", err)
			http.Error(w, "gateway handover: the successor did not answer: "+err.Error(), http.StatusBadGateway)
		},
	}
	return h
}

// dialAddrOf is where this host's own gateway is dialled: the first address
// -listen names, a wildcard as loopback.
func dialAddrOf(listen string) string {
	addrs := listenAddrs(listen)
	host, port, err := net.SplitHostPort(addrs[0].addr)
	if err != nil {
		return addrs[0].addr
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return net.JoinHostPort(host, port)
}

// handedOver: the successor serves (this generation closes its listeners
// and drains from here).
func (h *handover) handedOver() bool {
	if h == nil {
		return false
	}
	select {
	case <-h.replacedCh:
		return true
	default:
		return false
	}
}

func (h *handover) replaced() <-chan struct{} {
	if h == nil {
		return nil
	}
	return h.replacedCh
}

// isLocalCaller: the handover runs a binary, so it is answered only to a
// caller on this machine talking to the gateway directly — a loopback peer,
// a loopback Host, and nothing a front proxy (Caddy on a release host) adds.
func isLocalCaller(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return false
	}
	for name := range r.Header {
		if strings.HasPrefix(strings.ToLower(name), "x-forwarded-") || strings.EqualFold(name, "Forwarded") || strings.EqualFold(name, "Via") {
			return false
		}
	}
	switch hostOnly(r.Host) {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

// handoverStatus is GET /gateway/handover: who serves (never the
// environment, which holds secrets).
type handoverStatus struct {
	Protocol  int            `json:"protocol"`
	KeeperPid int            `json:"keeperPid"`
	Pid       int            `json:"pid"`
	Mode      generationMode `json:"mode"`
	Binary    string         `json:"binary"`
	Args      []string       `json:"args"`
	Dir       string         `json:"dir"`
	StartedAt int64          `json:"startedAt"`
}

func (h *handover) serve(w http.ResponseWriter, r *http.Request) {
	if h == nil {
		http.Error(w, "this gateway runs without a keeper: it cannot hand over (restart it instead)", http.StatusNotFound)
		return
	}
	switch r.Method {
	case http.MethodGet:
		l := h.kc.init.Launch
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(handoverStatus{
			Protocol: keeperProtocol, KeeperPid: h.kc.init.KeeperPid, Pid: pidSelf(), Mode: h.kc.init.Mode,
			Binary: l.Binary, Args: l.Args, Dir: l.Dir, StartedAt: h.started.UnixMilli(),
		})
	case http.MethodPost:
		if !isLocalCaller(r) {
			http.Error(w, "a handover is answered only to a local caller dialling the gateway directly", http.StatusForbidden)
			return
		}
		var req launchRequest
		body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
		if err == nil && len(strings.TrimSpace(string(body))) > 0 {
			err = json.Unmarshal(body, &req)
		}
		if err != nil {
			http.Error(w, "handover body: "+err.Error(), http.StatusBadRequest)
			return
		}
		pid, took, err := h.run(r.Context(), &req)
		if err != nil {
			slog.Warn("handover failed; this gateway keeps serving", "err", err)
			http.Error(w, "handover failed (this gateway keeps serving): "+err.Error(), http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"handedOver": true, "pid": pid, "tookMs": took.Milliseconds()})
	default:
		http.Error(w, "GET or POST", http.StatusMethodNotAllowed)
	}
}

// freezeBudget bounds the wait for in-flight transitions (a hot restart can
// take its readiness window).
const freezeBudget = 3 * time.Minute

func (h *handover) run(ctx context.Context, req *launchRequest) (int, time.Duration, error) {
	started := time.Now()
	fctx, cancel := context.WithTimeout(ctx, freezeBudget)
	err := h.gate.freeze(fctx)
	cancel()
	if err != nil {
		return 0, 0, err
	}
	state, err := json.Marshal(exportState(h.reg, h.deploy))
	if err != nil {
		h.gate.unfreeze()
		return 0, 0, err
	}
	slog.Info("handover: frozen; asking the keeper for a successor", "froze_in", time.Since(started), "binary", req.Binary)
	pid, err := h.kc.requestHandover(req, state)
	if err != nil {
		h.gate.unfreeze()
		return 0, 0, err
	}
	took := time.Since(started)
	slog.Info("handover: the successor serves; draining", "successor_pid", pid, "took", took)
	h.once.Do(func() { close(h.replacedCh) })
	return pid, took, nil
}

// onListenersClosed runs once this generation's copies of the listeners are
// closed: from here only the successor accepts, so a forwarded request
// cannot loop back here.
func (h *handover) onListenersClosed() {
	h.kc.detached.Store(true)
	h.gate.markReplaced()
	// Stop reading the backends' output: the successor reads it now (two
	// readers of one pipe would split its lines between them).
	for _, wt := range h.reg.List() {
		wt.mu.Lock()
		bk := backendOf(wt.phase)
		wt.mu.Unlock()
		if bk != nil && bk.proc != nil {
			closeFiles(bk.proc.Stdout, bk.proc.Stderr)
		}
	}
	if h.sup != nil {
		h.sup.StopAll() // the successor's watchdogs watch the services now
	}
	h.wsMu.Lock()
	n := len(h.ws)
	for c := range h.ws {
		_ = c.Close()
	}
	h.wsMu.Unlock()
	slog.Info("handover: listeners closed; WebSockets closed for their clients to reconnect to the successor", "websockets", n)
}

// trackWS registers a hijacked WebSocket client connection, closed when this
// generation is replaced. Returns false (and closes it) when already replaced.
func (h *handover) trackWS(c net.Conn) bool {
	if h == nil {
		return true
	}
	h.wsMu.Lock()
	defer h.wsMu.Unlock()
	if h.gate.isReplaced() {
		_ = c.Close()
		return false
	}
	h.ws[c] = struct{}{}
	return true
}

func (h *handover) untrackWS(c net.Conn) {
	if h == nil {
		return
	}
	h.wsMu.Lock()
	delete(h.ws, c)
	h.wsMu.Unlock()
}

// forwardIfHandedOver answers r from the successor when err (or this
// generation's state) says it was handed over. Reports whether it did.
func (h *handover) forwardIfHandedOver(w http.ResponseWriter, r *http.Request, err error) bool {
	if h == nil {
		return false
	}
	if !errors.Is(err, errHandedOver) && !(err == nil && h.gate.isReplaced()) {
		return false
	}
	// The connection ends after this answer; the client's next request
	// opens one to the successor.
	w.Header().Set("Connection", "close")
	h.forward.ServeHTTP(w, r)
	return true
}
