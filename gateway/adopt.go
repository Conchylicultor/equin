package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"os"
	"sort"
	"sync"
	"syscall"
	"time"
)

const sigTERM = syscall.SIGTERM

func contextBackground() context.Context { return context.Background() }

// unixHTTPClient is a one-off client to a backend's socket.
func unixHTTPClient(socketPath string, timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", socketPath)
			},
			DisableKeepAlives: true,
		},
	}
}

// ─── adopting a predecessor's children ─────────────────────────
//
// A generation started by a handover (or after its predecessor died) is
// handed every live child by the keeper. Each carries the tag its spawner
// wrote: a backend becomes the running backend of its worktree — the same
// process, no cold start — and a main-deploy run is watched to its end.

type childKind string

const (
	childBackend   childKind = "backend"
	childDeployRun childKind = "deploy-run"
)

// childTag is what a later generation needs to adopt a child.
type childTag struct {
	Kind childKind `json:"kind"`

	// backend
	Worktree   string `json:"worktree,omitempty"`
	Socket     string `json:"socket,omitempty"`
	StartedAt  int64  `json:"startedAt,omitempty"`
	Executable string `json:"executable,omitempty"`
	Checkout   string `json:"checkout,omitempty"`

	// deploy-run
	Causes    []string `json:"causes,omitempty"`
	LogOffset int64    `json:"logOffset,omitempty"`
}

// adoptProbeTimeout bounds the readiness probe of a backend adopted with no
// state to vouch for it (after a generation died).
const adoptProbeTimeout = 3 * time.Second

// adoptChildren makes this generation the owner of every child the keeper
// handed it. Returns the pids it adopted as backends (the orphan reconcile
// leaves their sockets alone).
//
// A worktree can have more than one live backend: the one serving, and a
// predecessor a hot restart is still draining. The serving one is the pid
// the handover's state names; with no state (a recover), the newest that
// answers ready. Every other is drained and stopped by this generation,
// exactly as its own restart would have (drainAfterPredecessor).
func adoptChildren(kc *keeperClient, reg *Registry, d *mainDeployer, st *generationState) map[int]bool {
	byName := map[string]worktreeState{}
	if st != nil {
		for _, ws := range st.Worktrees {
			byName[ws.Name] = ws
		}
	}
	type adoptee struct {
		c   *child
		tag childTag
	}
	backends := map[string][]adoptee{}
	adopted := map[int]bool{}
	for _, a := range kc.init.Children {
		var tag childTag
		if err := json.Unmarshal(a.Tag, &tag); err != nil {
			slog.Error("adopt: a child with an unreadable tag; stopping it", "pid", a.Pid, "err", err)
			c := kc.adopted(a)
			_ = killGroup(c, sigTERM)
			continue
		}
		c := kc.adopted(a)
		switch tag.Kind {
		case childBackend:
			if reg.Resolve(tag.Worktree) == nil {
				slog.Warn("adopt: a backend whose worktree is gone; stopping it", "pid", a.Pid, "worktree", tag.Worktree)
				_ = killGroup(c, sigTERM)
				continue
			}
			adopted[a.Pid] = true
			backends[tag.Worktree] = append(backends[tag.Worktree], adoptee{c, tag})
		case childDeployRun:
			if d == nil {
				slog.Warn("adopt: a main-deploy run, but this gateway deploys nothing; leaving it to finish", "pid", a.Pid)
				continue
			}
			d.adoptRun(c, tag)
		default:
			slog.Warn("adopt: a child of unknown kind; leaving it", "pid", a.Pid, "kind", tag.Kind)
		}
	}
	var wg sync.WaitGroup
	for name, list := range backends {
		wt := reg.Resolve(name)
		ws, hasState := byName[name]
		// Newest first: with no state, the newest backend that answers is
		// the serving one.
		sort.Slice(list, func(i, j int) bool { return list[i].tag.StartedAt > list[j].tag.StartedAt })
		wg.Add(1)
		go func() {
			defer wg.Done()
			serving := false
			for _, a := range list {
				switch {
				case hasState && ws.Pid == a.c.Pid && ws.ReadyAt > 0:
					serving = wt.adoptBackend(a.c, a.tag, ws, true)
				case !hasState && !serving:
					serving = wt.adoptBackend(a.c, a.tag, ws, false)
				default:
					wt.adoptDraining(a.c, a.tag)
				}
			}
		}()
	}
	wg.Wait()
	// Worktrees with no adopted backend keep their hold / broken boot.
	for name, ws := range byName {
		if ws.Pid != 0 && adopted[ws.Pid] {
			continue
		}
		if wt := reg.Resolve(name); wt != nil {
			wt.restoreIdleState(ws)
		}
	}
	return adopted
}

func (w *Worktree) adoptedBackend(c *child, tag childTag) *backend {
	bk := &backend{
		proc:       c,
		exitCh:     make(chan struct{}),
		startedAt:  tag.StartedAt,
		socketPath: tag.Socket,
		stderrTail: newLineTail(crashTailLines),
		stderrDone: make(chan struct{}),
		executable: tag.Executable,
		checkout:   tag.Checkout,
	}
	w.superviseBackend(bk)
	return bk
}

// adoptDraining takes over a backend the predecessor was draining (a hot
// restart's old process): drained and stopped here, once no older generation
// can still be proxying to it.
func (w *Worktree) adoptDraining(c *child, tag childTag) {
	bk := w.adoptedBackend(c, tag)
	// A stop of a backend that is not serving: its exit is no crash.
	slog.Info("adopt: a backend the predecessor was draining; draining it here", "worktree", w.Name, "pid", c.Pid)
	go w.drainAfterPredecessor(bk)
}

// adoptBackend makes c this worktree's running backend, and reports whether
// it did. vouched: the predecessor handed it over running (no probe needed);
// otherwise one readiness probe decides, and a backend that does not answer
// ready is stopped (its next request cold-starts it).
func (w *Worktree) adoptBackend(c *child, tag childTag, ws worktreeState, vouched bool) bool {
	bk := w.adoptedBackend(c, tag)
	readyAt := ws.ReadyAt
	if !vouched {
		if err := probeReady(tag.Socket, adoptProbeTimeout); err != nil {
			slog.Warn("adopt: backend not ready; stopping it", "worktree", w.Name, "pid", c.Pid, "err", err)
			w.terminateBackend(contextBackground(), bk, "adopted but not ready")
			w.releaseBackendArtifacts(bk)
			return false
		}
		readyAt = time.Now().UnixMilli()
	}
	bk.readyAt.Store(readyAt)
	bk.proxy = newReverseProxy(tag.Socket)
	w.mu.Lock()
	if bk.exited {
		w.mu.Unlock()
		slog.Warn("adopt: backend exited while being adopted", "worktree", w.Name, "pid", c.Pid)
		return false
	}
	if _, idle := w.phase.(phaseIdle); !idle {
		found := w.phase
		w.mu.Unlock()
		slog.Error("adopt: worktree not idle; draining the adopted backend", "worktree", w.Name, "found", found.state())
		go w.drainAfterPredecessor(bk)
		return false
	}
	w.phase = runningOn(bk)
	if ws.LastActivity > 0 {
		w.lastActivity = time.UnixMilli(ws.LastActivity)
	} else {
		w.lastActivity = time.Now()
	}
	w.mu.Unlock()
	slog.Info("adopt: backend adopted", "worktree", w.Name, "pid", c.Pid, "socket", tag.Socket, "vouched", vouched)
	return true
}

// restoreIdleState puts back a hold or a broken boot the predecessor had.
func (w *Worktree) restoreIdleState(ws worktreeState) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, idle := w.phase.(phaseIdle); !idle {
		return
	}
	switch {
	case ws.Held:
		w.phase = phaseIdle{held: true}
	case ws.BrokenErr != "":
		w.phase = phaseBroken{err: errString(ws.BrokenErr), until: time.UnixMilli(ws.BrokenUntil)}
	}
	if ws.LastActivity > 0 {
		w.lastActivity = time.UnixMilli(ws.LastActivity)
	}
}

type errString string

func (e errString) Error() string { return string(e) }

// probeReady asks a backend's readiness endpoint once.
func probeReady(socketPath string, timeout time.Duration) error {
	client := unixHTTPClient(socketPath, timeout)
	resp, err := client.Get("http://backend/api/health/ready")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound {
		return errString(resp.Status)
	}
	return nil
}

func pidSelf() int { return os.Getpid() }
