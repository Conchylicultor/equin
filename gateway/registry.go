package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// A namespace is `<composition>.<checkout>` with both sentinels elided, so it is
// one or more dot-joined DNS labels. Written as a per-label composition rather
// than by adding `.` to the charset, because this shape structurally forbids the
// only ways a dotted name could stop being a single safe path segment: `..`, an
// empty label, a leading dot, a trailing dot. (`name` is used as one path
// component — `filepath.Join(RegistryDir, name, "spec.json")` — and as a
// filename stem, `name+".sock"`.)
//
// Deliberately NOT capped at two labels: the gateway validates path-safety, not
// meaning. It treats a namespace as an opaque directory key and never
// decomposes it, which is why the elision rule has exactly one implementation
// (TypeScript's `namespaceFor`) and nothing here to drift from it. The semantic
// two-label cap lives there, in `NAMESPACE_RE`.
//
// KEEP IN SYNC with `NAMESPACE_RE`'s label rule in
// plugins/infra/plugins/namespace/core/namespace.ts — enforced by the
// `namespace:grammar-in-sync` check, which reads this literal.
var nameRegex = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9-]{0,62})*$`)

// maxNamespaceBytes caps a whole namespace, mirroring NAMESPACE_MAX_BYTES in
// plugins/infra/plugins/namespace/core/namespace.ts (also read by the
// `namespace:grammar-in-sync` check).
//
// A namespace is also the app's Postgres database name, and NAMEDATALEN is 64,
// so Postgres truncates `datname` at 63 bytes without complaining: two
// namespaces agreeing on their first 63 bytes would share ONE database. The cap
// is enforced at the TypeScript minter, which is where a name is invented; it is
// mirrored here because the gateway validates names it did not mint — read off
// the registry directory and off a Host header — and admitting one it cannot
// serve a coherent database for is a 404 nobody can explain.
//
// A length test rather than a regex clause: Go's RE2 has no lookahead, so the
// cap cannot ride inside `nameRegex` the way it does in NAMESPACE_RE.
const maxNamespaceBytes = 63

// validNamespace is the ONLY way to ask "is this string a namespace?" in the
// gateway. `nameRegex` alone is not the rule — a call site that matched the
// regex and forgot the length would admit a name whose database is a DIFFERENT
// name — so the two halves are joined here rather than at four call sites.
func validNamespace(name string) bool {
	return len(name) <= maxNamespaceBytes && nameRegex.MatchString(name)
}

// Registry is the in-memory collection of worktrees, populated from JSON
// files in cfg.RegistryDir and kept in sync via fsnotify.
type Registry struct {
	cfg *Config

	mu     sync.RWMutex
	byName map[string]*Worktree
}

func NewRegistry(cfg *Config) *Registry {
	return &Registry{
		cfg:    cfg,
		byName: make(map[string]*Worktree),
	}
}

// HasName reports whether a worktree with the given name is registered.
// Used by reconcileOrphanBackends to classify orphan socket files.
func (r *Registry) HasName(name string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, ok := r.byName[name]
	return ok
}

// Get returns the worktree with the given name, or nil if absent. Pure
// in-memory lookup — never touches disk.
func (r *Registry) Get(name string) *Worktree {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.byName[name]
}

// Resolve returns the worktree for name, registering it on demand from disk if a
// spec.json exists but the in-memory registry has not caught it yet. This makes
// request routing correct independent of fsnotify health: under watch-FD pressure
// (thousands of worktree dirs) a create event can be dropped, but any worktree
// whose spec.json is on disk is still reachable on its first request. Returns nil
// for an invalid name or a name with no spec on disk. Idempotent and concurrency-
// safe: loadFile's upsert collapses concurrent loads to a single registration.
func (r *Registry) Resolve(name string) *Worktree {
	if wt := r.Get(name); wt != nil {
		return wt
	}
	if r.cfg.RegistryDir == "" || !validNamespace(name) {
		return nil
	}
	specPath := filepath.Join(r.cfg.RegistryDir, name, "spec.json")
	if _, err := os.Stat(specPath); err != nil {
		return nil
	}
	r.loadFile(specPath)
	return r.Get(name)
}

// RefreshSpec re-reads <name>/spec.json now, applying it if it is a revision
// the registry has not loaded. Reconcile does the same on its own schedule;
// this is the on-demand form, so a caller that has just rewritten the file does
// not have to race a tick.
//
// Its one caller is the restart route: a build writes spec.json and immediately
// POSTs /gateway/worktrees/<name>/restart, and Restart snapshots w.Spec() to
// spawn with — so refreshing first is what makes a changed `server`/`command`
// take effect on the restart the build asked for rather than on some later
// respawn. A changed `web` is applied by the same call and is live on the next
// static request.
//
// Never evicts and never errors out: an absent or unreadable spec leaves the
// worktree exactly as it is (see loadFile).
func (r *Registry) RefreshSpec(name string) {
	if r.cfg.RegistryDir == "" || !validNamespace(name) {
		return
	}
	specPath := filepath.Join(r.cfg.RegistryDir, name, "spec.json")
	fi, err := os.Stat(specPath)
	if err != nil {
		return
	}
	if wt := r.Get(name); wt != nil && wt.SpecRev() == specRevOf(fi) {
		return
	}
	r.loadFile(specPath)
}

// List returns a snapshot of all known worktrees.
func (r *Registry) List() []*Worktree {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*Worktree, 0, len(r.byName))
	for _, w := range r.byName {
		out = append(out, w)
	}
	return out
}

// LoadAll scans cfg.RegistryDir once at startup, populating the registry from
// each worktree's <name>/spec.json subdirectory. Non-directory entries — stray
// build-profile/build-logs JSON artifacts and leftover flat legacy specs that
// share the dir — are ignored: only the per-worktree subdir layout is a
// worktree. Creates the directory if missing.
func (r *Registry) LoadAll() error {
	if err := os.MkdirAll(r.cfg.RegistryDir, 0o755); err != nil {
		return fmt.Errorf("create registry dir: %w", err)
	}
	entries, err := os.ReadDir(r.cfg.RegistryDir)
	if err != nil {
		return fmt.Errorf("read registry dir: %w", err)
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		specPath := filepath.Join(r.cfg.RegistryDir, e.Name(), "spec.json")
		if _, err := os.Stat(specPath); err == nil {
			r.loadFile(specPath)
		}
	}
	slog.Info("registry loaded", "count", len(r.byName), "dir", r.cfg.RegistryDir)
	return nil
}

// Watch blocks until ctx is done, keeping the registry in sync via a SINGLE
// fsnotify watch on the registry dir itself. It deliberately does NOT add a watch
// per worktree subdirectory: with thousands of worktree dirs that exhausts the
// kqueue/open-file budget on macOS, and a dropped per-subdir w.Add silently loses
// the worktree forever (the later spec.json write produces no observable event).
// Instead correctness is decoupled from the watch:
//
//   - the dir-level watch catches subdir create/remove for low-latency
//     register/unregister of <name>/spec.json worktrees, and
//   - Resolve loads a spec on demand on first request, while Reconcile
//     periodically re-scans the dir — so a worktree whose spec.json is written
//     *after* its dir is created (the build creates the dir early for logs and
//     writes spec.json last) is always picked up, by design.
func (r *Registry) Watch(ctx context.Context) error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	defer w.Close()
	if err := w.Add(r.cfg.RegistryDir); err != nil {
		return err
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-w.Events:
			if !ok {
				return nil
			}

			// A new worktree subdir appeared. Its spec.json may already be present
			// (dev writes mkdir+spec back-to-back) — register it immediately. If
			// spec.json is written later, Reconcile/Resolve picks it up.
			if ev.Op&fsnotify.Create != 0 {
				if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
					specPath := filepath.Join(ev.Name, "spec.json")
					if _, serr := os.Stat(specPath); serr == nil {
						r.loadFile(specPath)
					}
					continue
				}
			}

			// A worktree subdir disappeared — unregister it by its bare name. A
			// removed flat file (a build-profile/build-logs artifact, never a
			// registered worktree) resolves to an unregistered name, so r.remove
			// is a harmless no-op.
			if ev.Op&(fsnotify.Remove|fsnotify.Rename) != 0 {
				r.remove(filepath.Base(ev.Name))
				continue
			}
		case werr, ok := <-w.Errors:
			if !ok {
				return nil
			}
			slog.Warn("watcher error", "err", werr)
		}
	}
}

// Reconcile blocks until ctx is done, periodically re-scanning the registry dir to
// repair any drift the fsnotify watch missed. This is the backstop that makes
// registration correct under watch-FD pressure (the watch+reconcile informer
// pattern): it registers worktrees whose spec.json appeared without a delivered
// event, and unregisters worktrees whose backing registry dir/file OR backing
// server dir (spec.Server) was removed out from under us (e.g. by
// worktree-cleanup or a manual `git worktree remove`). fsnotify stays the
// low-latency fast path; this is the periodic safety net.
func (r *Registry) Reconcile(ctx context.Context) {
	t := time.NewTicker(r.cfg.ReconcileInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.reconcileOnce()
		}
	}
}

func (r *Registry) reconcileOnce() {
	entries, err := os.ReadDir(r.cfg.RegistryDir)
	if err != nil {
		slog.Warn("reconcile: read registry dir failed", "dir", r.cfg.RegistryDir, "err", err)
		return
	}
	present := make(map[string]bool, len(entries))
	for _, e := range entries {
		// Only <name>/spec.json subdirs are worktrees. Flat .json files sharing
		// the dir (build-profile/build-logs artifacts, leftover legacy specs) are
		// not worktrees and are skipped — re-attempting to parse them as specs is
		// exactly what produced ~1.3k "failed to load legacy spec" warns per tick.
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		present[name] = true
		specPath := filepath.Join(r.cfg.RegistryDir, name, "spec.json")
		fi, serr := os.Stat(specPath)
		if serr != nil {
			// No readable spec.json. Never an eviction: unregistration is keyed
			// on DIR presence (below), so a non-atomic rewrite that briefly
			// leaves no file cannot drop a live worktree.
			continue
		}
		// Registered AND the file is the same revision we loaded → nothing to do.
		// This is the steady-state path for nearly every dir, and costs exactly
		// one stat: ~12µs each, so ~1ms per tick at ~90 namespaces, i.e. 0.01%
		// of one core at the default 10s interval. The pre-existing ReadDir on
		// the same dir already costs a fifth of that.
		if wt := r.Get(name); wt != nil && wt.SpecRev() == specRevOf(fi) {
			continue
		}
		// Either not registered yet, or the spec.json on disk is a revision we
		// have not loaded — a build rewriting `web` at a new dist is exactly
		// this case. loadFile re-reads and upsert applies it.
		r.loadFile(specPath)
	}
	// Unregister worktrees whose backing dir/file vanished. Keyed on dir/file
	// presence, NOT spec.json presence, so a non-atomic spec rewrite can never
	// transiently evict a live worktree.
	for _, wt := range r.List() {
		if !present[wt.Name] {
			slog.Info("reconcile: worktree dir gone, unregistering", "name", wt.Name)
			r.remove(wt.Name)
			continue
		}
		// Also evict registrations whose backing server dir (spec.Server, a git
		// worktree path distinct from the registry subdir above) was removed
		// after registration — e.g. by worktree-cleanup or a manual `git
		// worktree remove`. Without this the registry subdir lingers, so the
		// dir-presence check never fires and the dead entry stays in byName
		// forever, only ever failing to spawn. serverPathMissing is ENOENT-only,
		// so a transient stat error never evicts a live worktree.
		if server := wt.Spec().Server; serverPathMissing(server) {
			slog.Info("reconcile: worktree server path gone, unregistering", "name", wt.Name, "server", server)
			r.remove(wt.Name)
		}
	}
}

// serverPathMissing reports whether a worktree's backing server directory is
// confirmed absent. Only a definitive ErrNotExist counts: a transient stat error
// (permissions, a volume unmounted mid-check) is treated as present, so an FS
// hiccup never evicts or rejects a live worktree — the same conservatism as the
// registry-dir presence check, which keys on existence rather than contents.
func serverPathMissing(server string) bool {
	if server == "" {
		return false // loadSpec already rejects an empty server; never evict on it
	}
	_, err := os.Stat(server)
	return errors.Is(err, os.ErrNotExist)
}

// Sweep blocks until ctx is done, periodically tearing down idle backends.
func (r *Registry) Sweep(ctx context.Context) {
	t := time.NewTicker(r.cfg.SweepInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for _, wt := range r.List() {
				if wt.ShouldSweep(r.cfg.IdleTimeout) {
					slog.Info("sweeping idle worktree", "worktree", wt.Name)
					if err := wt.Stop(ctx); err != nil {
						slog.Warn("sweep stop failed", "worktree", wt.Name, "err", err)
					}
				}
			}
		}
	}
}

// StopAll stops every running worktree, called from main on shutdown.
func (r *Registry) StopAll(ctx context.Context) error {
	var wg sync.WaitGroup
	for _, wt := range r.List() {
		wg.Add(1)
		go func(wt *Worktree) {
			defer wg.Done()
			_ = wt.Stop(ctx)
		}(wt)
	}
	wg.Wait()
	return nil
}

// ─── internal ────────────────────────────────────────────────

func (r *Registry) loadFile(path string) {
	name := nameFromPath(path)
	if !validNamespace(name) {
		slog.Warn("invalid worktree name", "name", name, "path", path)
		return
	}
	// Every rejection below LEAVES A REGISTERED WORKTREE EXACTLY AS IT WAS —
	// same spec, same backend, still routable. A spec.json that is malformed,
	// truncated mid-write, or momentarily unreadable is a failure to *learn
	// something new*, never a reason to forget what we already know. This is
	// the same conservatism as the dir-presence keying in reconcileOnce.
	spec, err := loadSpec(path)
	if err != nil {
		if r.Get(name) != nil {
			slog.Warn("failed to load spec; keeping the previously loaded one", "name", name, "path", path, "err", err)
		} else {
			slog.Warn("failed to load spec", "path", path, "err", err)
		}
		return
	}
	// Never register a spec whose backing worktree is already gone — the
	// build creates ~/.equin/worktrees/<name> (logs, spec.json) at a
	// different location than spec.Server (the git worktree's server dir), so
	// the registry subdir can outlive the worktree it points at. A born-dead
	// registration would only ever fail to spawn. Skip at Debug: the reconcile
	// hot path re-attempts this every tick for leftover on-disk specs, so a
	// louder level would spam.
	//
	// For an ALREADY-registered worktree this also declines to adopt a rewrite
	// that repoints `server` at a path that does not exist: the old spec stays
	// live rather than the worktree becoming unspawnable. reconcileOnce's own
	// eviction check then judges the still-live old spec on its own terms.
	if serverPathMissing(spec.Server) {
		slog.Debug("skipping worktree: backing server dir gone", "name", name, "server", spec.Server)
		return
	}
	r.upsert(name, spec)
}

func (r *Registry) upsert(name string, spec *Spec) {
	r.mu.Lock()
	wt, exists := r.byName[name]
	if !exists {
		newWt, err := NewWorktree(name, spec, r.cfg)
		if err != nil {
			r.mu.Unlock()
			slog.Warn("worktree rejected", "name", name, "err", err)
			return
		}
		r.byName[name] = newWt
		r.mu.Unlock()
		slog.Info("worktree registered", "name", name, "server", spec.Server, "web", spec.Web, "socket", newWt.primarySocketPath())
		return
	}
	r.mu.Unlock()
	// Already registered. Apply the spec only when it came from a DIFFERENT
	// spec.json revision than the one in memory. Deciding this here rather than
	// in each caller makes "no churn" an invariant of the registry instead of
	// something LoadAll / Watch / Resolve / Reconcile each have to remember: an
	// unconditional loadFile is always safe, and the reconcile stat gate is a
	// pure cost optimization on top, never a correctness dependency.
	if wt.SpecRev() == spec.rev {
		return
	}
	prev := wt.Spec()
	wt.UpdateSpec(spec)
	slog.Info("worktree spec updated", "name", name,
		"server", spec.Server, "web", spec.Web,
		"prevServer", prev.Server, "prevWeb", prev.Web)
}

func (r *Registry) remove(name string) {
	r.mu.Lock()
	wt, exists := r.byName[name]
	if !exists {
		r.mu.Unlock()
		return
	}
	delete(r.byName, name)
	r.mu.Unlock()
	slog.Info("worktree unregistered", "name", name)
	go func() {
		_ = wt.Stop(context.Background())
		wt.CloseLog()
	}()
}

// loadSpec parses a spec.json and stamps it with the fingerprint of the exact
// file revision it read.
//
// It opens ONCE and stats the file descriptor rather than the path: a concurrent
// temp+rename swaps the directory entry but leaves this fd on the inode it is
// reading, so the returned rev describes the returned bytes exactly. Statting
// the path instead could pair the new file's fingerprint with the old file's
// content — recording a revision as loaded that never was, which is precisely
// the "gateway thinks it is current" failure this whole mechanism exists to
// remove. The rewrite is then observed on the next tick, whose stat sees the
// new inode.
func loadSpec(path string) (*Spec, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}
	var spec Spec
	if err := json.Unmarshal(data, &spec); err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	spec.rev = specRevOf(fi)
	if spec.Server == "" {
		return nil, errors.New("server is required")
	}
	if !filepath.IsAbs(spec.Server) {
		return nil, errors.New("server must be an absolute path")
	}
	// Web is optional — headless backends (e.g. central) have no UI bundle.
	if spec.Web != "" && !filepath.IsAbs(spec.Web) {
		return nil, errors.New("web must be an absolute path when provided")
	}
	return &spec, nil
}

// nameFromPath extracts the worktree name from a path: <dir>/<name>/spec.json
func nameFromPath(p string) string {
	return filepath.Base(filepath.Dir(p))
}

const (
	reconcileDialTimeout = 300 * time.Millisecond
	reconcileKillGrace   = 2 * time.Second
	reconcileConcurrency = 8
)

// socketStem derives the worktree name from a <name>.sock or <name>.next.sock
// filename.
func socketStem(name string) string {
	if s, ok := strings.CutSuffix(name, ".next.sock"); ok {
		return s
	}
	return strings.TrimSuffix(name, ".sock")
}

// reconcileOrphanBackends asserts the gateway's ownership invariant at boot:
// since the gateway has spawned ZERO backends at this point, any process still
// bound to a worktree socket is an orphan from a prior gateway generation and
// must be reaped. It supersedes the old name-based stale-socket sweep —
// crucially, it does NOT skip registered worktrees (a registered worktree with
// a live orphan socket is exactly the leak this fixes).
//
// MUST run synchronously before the watcher/sweep/eager-central goroutines
// start (see main.go) — the "zero backends yet" invariant evaporates the instant
// the gateway begins spawning, so this is safe only at boot and is never run
// periodically.
//
// Per socket: a bare connect is the liveness gate (a wedged-but-bound backend
// still completes the connection — and we want to reap it). Not live → remove
// the socket + pid sidecar. Live + sidecar → kill the recorded process group,
// then remove. Live + no sidecar (legacy backend predating the sidecar) → log
// loudly and leave it; the per-spawn unlink and the backend's own ppid-poll
// escape hatch clean it up.
func reconcileOrphanBackends(dir string, reg *Registry) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		slog.Warn("sockets dir scan failed", "dir", dir, "err", err)
		return
	}

	sockets := make(map[string]bool)
	var wg sync.WaitGroup
	sem := make(chan struct{}, reconcileConcurrency)
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".sock") {
			continue
		}
		sockets[name] = true
		path := filepath.Join(dir, name)
		stem := socketStem(name)
		wg.Add(1)
		sem <- struct{}{}
		go func(path, stem string) {
			defer wg.Done()
			defer func() { <-sem }()
			reconcileOneSocket(path, stem, reg)
		}(path, stem)
	}
	wg.Wait()

	// GC orphan *.pid sidecars whose socket file is already gone (the live
	// branches above remove sidecars alongside their sockets, so those are
	// already handled).
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".pid") {
			continue
		}
		sockName := strings.TrimSuffix(name, ".pid")
		if sockets[sockName] {
			continue
		}
		if _, statErr := os.Stat(filepath.Join(dir, sockName)); errors.Is(statErr, os.ErrNotExist) {
			p := filepath.Join(dir, name)
			if rmErr := os.Remove(p); rmErr != nil && !errors.Is(rmErr, os.ErrNotExist) {
				slog.Warn("remove orphan sidecar failed", "path", p, "err", rmErr)
			} else {
				slog.Info("removed orphan pid sidecar", "path", p)
			}
		}
	}

	slog.Info("orphan reconcile complete", "dir", dir)
}

func reconcileOneSocket(path, stem string, reg *Registry) {
	registered := reg.HasName(stem)
	if !backendListening(path) {
		// Nothing bound — stale socket file. Remove socket + sidecar.
		_ = removeBackendArtifacts(path)
		slog.Info("removed stale socket", "path", path, "registered", registered)
		return
	}
	// A process is bound at boot: an orphan from a prior gateway generation.
	sc, err := readBackendSidecar(path)
	if err != nil || sc == nil {
		slog.Error("live orphan backend with no pid record; reap manually (lsof -U / kill)",
			"path", path, "registered", registered, "err", err)
		return
	}
	slog.Warn("reaping orphan backend from prior gateway generation",
		"path", path, "pid", sc.PID, "pgid", sc.PGID, "wallStart", sc.WallStart, "registered", registered)
	reapPgid(sc.PGID, sc.PID, reconcileKillGrace, path)
	_ = removeBackendArtifacts(path)
}

// backendListening reports whether a process is bound to the Unix socket. A bare
// connect suffices: the kernel completes it into the listen backlog even if the
// backend's event loop is wedged and never accept()s — which is precisely a case
// we want to treat as "live, reap it".
func backendListening(socketPath string) bool {
	c, err := net.DialTimeout("unix", socketPath, reconcileDialTimeout)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}
