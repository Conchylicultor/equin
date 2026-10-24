# Gateway Design — v2

## Changes from v1

After re-reasoning from first principles about how SPA + backend apps are canonically deployed, two things changed:

1. **Static serving model reverted to "gateway serves statics directly"** (Model A). The gateway reads each worktree's `web/dist` and serves files itself. The backend is no longer required to grow a static-serving feature. Page loads are instant; backend cold-start happens only on the first `/api/*` or `/ws/*` request. This restores the lazy-spawn property the architecture was designed to provide — opening a worktree page costs zero backend processes.

2. **Dashboard removed from gateway scope**. The dashboard will be a frontend plugin inside the equin app itself, querying `/gateway/worktrees`. The gateway no longer renders HTML or embeds templates.

Everything else (Go, subdomain routing, lazy spawn, idle teardown, port allocation, discovery, `/gateway/*` API, `~/.singularity/worktrees/`) is unchanged.

---

## Context

equin lets users run multiple isolated instances of the agent-manager app — one per agent worktree — and switch between them seamlessly. We need a gateway that listens on a single port, routes by subdomain, owns backend lifecycles, and treats each worktree as a deployable unit.

The deployable unit is **two artifacts**: a static frontend bundle (`web/dist`) and a backend service (a `bun` process). This split is the standard modern web architecture (Vercel, Netlify, Cloudflare Pages, Amplify, every K8s app). It exists because the two halves have fundamentally different characteristics:

- Statics are cheap to serve, cacheable, always-warm, zero memory.
- Backends are expensive to start, stateful, scale-sensitive, idle-able.

Collapsing them into one process trades runtime efficiency for mental-model simplicity. equin's whole point is runtime efficiency (lazy spawn, idle teardown), so the split is the right choice.

This doc specifies a Go reverse-proxy gateway that:

1. Listens on `:9000`, routes `<worktree>.localhost:9000` → that worktree.
2. Serves `web/dist` directly for each worktree from the filesystem (no spawn).
3. Lazily spawns the backend on first `/api/*` or `/ws/*` request, tears down after 10 minutes idle.
4. Allocates backend ports dynamically; backends never know the gateway exists.
5. Discovers worktrees via JSON files in `~/.singularity/worktrees/`.
6. Exposes `/gateway/*` on every host as an official API for apps to query gateway state.

The CLI (`.singularity build`), the dashboard (frontend plugin), and the terminal hardcoded-URL fix are **out of scope**.

---

## Architecture overview

```
                ┌──────────────────────────────────────────────┐
   Browser ───▶ │   Gateway (Go) on :9000                      │
                │                                              │
                │   Host → worktree name (subdomain)           │
                │                                              │
                │   ┌── /gateway/*           → gateway API     │
                │   │                                          │
                │   ├── /api/*, /ws/*        → proxy to backend│
                │   │                          (lazy spawn)    │
                │   │                                          │
                │   └── everything else      → static file     │
                │                              from web/dist   │
                │                              (no spawn)      │
                └────────────┬─────────────────────────────────┘
                             │
                  proxied to 127.0.0.1:<allocated-port> (backend)
                             │
                ┌────────────▼──────────────┐
                │  Backend (bun, owned by   │
                │  gateway, spawned on      │
                │  first /api or /ws        │
                │  request, killed when     │
                │  idle for 10 minutes)     │
                │                           │
                │  Serves /api/* and /ws/*  │
                │  ONLY. No statics.        │
                └───────────────────────────┘

                Filesystem: <worktree>/web/dist/  (read by gateway)
```

**Key principle**: the gateway is pure plumbing. It serves bytes from disk and forwards bytes over sockets. It does not parse HTML, does not know about plugins, does not know about the API contract. Static serving counts as plumbing — `http.FileServer` with SPA fallback is ~60 lines and stays well within "knows nothing about content."

---

## Registry: file format and location

**Location**: `~/.singularity/worktrees/<name>.json` (user-global, single source of truth across the machine).

**Format**:
```json
{
  "name": "head",
  "worktreeDir": "/Users/me/src/singularity",
  "webDist": "/Users/me/src/singularity/web/dist",
  "backend": {
    "cwd": "/Users/me/src/singularity/server",
    "command": ["bun", "run", "start"],
    "env": { "NODE_ENV": "production" },
    "portEnv": "PORT",
    "readyTimeoutMs": 15000
  }
}
```

| Field | Required | Purpose |
|---|---|---|
| `name` | yes | Must match the filename and `^[a-z0-9][a-z0-9-]{0,62}$` (DNS-label safe). Filename is authoritative. |
| `worktreeDir` | yes | Informational; absolute path to the worktree root. |
| `webDist` | yes | Absolute path to the directory of built static assets. Must contain `index.html`. The gateway serves files directly from here. |
| `backend.cwd` | yes | Working directory for `exec.Cmd`. Absolute. |
| `backend.command` | yes | argv for the child. Not a shell string. |
| `backend.env` | no | Extra env vars merged on top of gateway's env. |
| `backend.portEnv` | no | Default `"PORT"`. Env var the backend reads to pick its port. |
| `backend.readyTimeoutMs` | no | Default `15000`. Max wait for TCP readiness before declaring spawn failure. |

The build CLI (out of scope) writes these files. For day-1 use, hand-write `~/.singularity/worktrees/head.json`.

**Note**: the backend must read its port from the `PORT` env var (or whatever `portEnv` names). The current `server/src/index.ts` hardcodes `9001` — that needs to change. This is a tiny modification (`port: parseInt(Bun.env.PORT || "9001", 10)`) and the only required server-side change for the gateway.

---

## Go package layout

Single Go module under `gateway/`. External deps: `github.com/fsnotify/fsnotify` only; everything else is stdlib.

```
gateway/
├── go.mod
├── go.sum
├── README.md
├── cmd/gateway/main.go              (~80)
└── internal/
    ├── config/config.go             (~60)
    ├── registry/
    │   ├── registry.go              (~180)
    │   └── paths.go                 (~70)
    ├── discovery/watcher.go         (~140)
    ├── portpool/portpool.go         (~70)
    ├── backend/
    │   ├── backend.go               (~220)
    │   └── readiness.go             (~40)
    ├── proxy/
    │   ├── router.go                (~120)
    │   ├── http.go                  (~60)
    │   ├── ws.go                    (~90)
    │   └── static.go                (~60)
    ├── gatewayapi/api.go            (~80)
    ├── sweeper/sweeper.go           (~60)
    └── logx/logx.go                 (~40)
```

Roughly **~1250 lines** of Go for v1.

### Per-package responsibilities

- **cmd/gateway/main.go** — flag parsing, wire components, signal handling, `http.Server.ListenAndServe`.
- **config** — flags + defaults. Pure value type.
- **registry** — in-memory, thread-safe map of `Worktree` state. Owns the per-worktree state machine.
- **discovery** — fsnotify loop on `~/.singularity/worktrees/`, feeds the registry.
- **portpool** — free-list allocator for ports 9001–10000 with `net.Listen` probe to skip busy ports.
- **backend** — process supervision (spawn, wait, stop, stdout/stderr pumps).
- **proxy/router** — top-level `http.Handler`. Parses Host, dispatches to gatewayapi / static / backend proxy.
- **proxy/http** — `httputil.ReverseProxy` instances per worktree, cached.
- **proxy/ws** — WebSocket proxy via `http.Hijacker` + two `io.Copy`s (~90 lines, no external lib). Bumps `activeConns` for the duration.
- **proxy/static** — `http.FileServer` over `webDist` with SPA fallback (serve `index.html` for non-file paths that 404).
- **gatewayapi** — handlers for `/gateway/*`. v1 ships `GET /gateway/worktrees` (JSON list).
- **sweeper** — ticker goroutine that scans the registry and tears down idle backends.
- **logx** — thin wrapper over `log/slog` with `WithWorktree(name)`.

---

## Internal data model

```go
// registry/registry.go

type State int
const (
    StateIdle     State = iota // known but no backend process
    StateStarting              // spawning, readiness pending
    StateRunning               // backend serving traffic
    StateStopping              // graceful shutdown in flight
    StateBroken                // last spawn failed; cooldown before retry
)

type Worktree struct {
    Name string
    Spec PathsSpec       // immutable snapshot from <name>.json

    mu           sync.Mutex
    state        State
    port         int                       // 0 when not allocated
    proc         *backend.Process          // nil when not running
    proxy        *httputil.ReverseProxy    // built once when running
    lastActivity time.Time                 // backend activity only, NOT static hits
    activeConns  int                       // in-flight HTTP-to-backend + open WS
    brokenUntil  time.Time
    readyCh      chan error                // closed on Starting → Running/Broken
    pendingSpec  *PathsSpec                // set when spec changes mid-run
}

type Registry struct {
    mu     sync.RWMutex
    byName map[string]*Worktree
    pool   *portpool.Pool
    cfg    config.Config
    log    *slog.Logger
}
```

**State scope**: every field on `Worktree` other than `Name` and `Spec` is about the *backend lifecycle*. Static-serving uses only `Spec.WebDist` and is fully stateless. The `Worktree` struct exists to track a process you may or may not have running; serving statics doesn't touch it at all.

**Mutex strategy**:
- `Registry.mu` (RWMutex) guards map membership only. Held briefly. Never held during I/O.
- `Worktree.mu` guards per-worktree state. For long ops (spawn, readiness, stop): lock → snapshot → unlock → do work → relock → commit.
- Concurrent callers during a cold-start observe `StateStarting` and block on `readyCh` instead of holding the mutex.

---

## Request flow

**Routing decision tree** (`proxy/router.go`):

```go
worktree := parseWorktree(r.Host)            // "" for localhost / 127.0.0.1 / [::1]

// Reserved gateway API — every host
if strings.HasPrefix(r.URL.Path, "/gateway/") {
    gatewayapi.Handle(w, r, worktree)
    return
}

// No subdomain → there is no app to serve. Redirect to head if registered, else 404.
if worktree == "" {
    if registry.Has("head") {
        http.Redirect(w, r, "http://head.localhost"+r.URL.RequestURI(), http.StatusFound)
    } else {
        http.Error(w, "equin gateway. Use <name>.localhost:9000.", http.StatusNotFound)
    }
    return
}

wt := registry.Get(worktree)
if wt == nil {
    http.NotFound(w, r)                      // "unknown worktree: <name>"
    return
}

// Backend-bound paths: lazy spawn + proxy
if isBackendPath(r.URL.Path) {
    if err := wt.Ensure(ctx); err != nil {
        http.Error(w, err.Error(), http.StatusBadGateway)
        return
    }
    if isWebSocketUpgrade(r) {
        proxy.WS(w, r, wt)                   // increments/decrements activeConns
    } else {
        wt.Proxy().ServeHTTP(w, r)
    }
    wt.TouchBackend()                        // resets lastActivity
    return
}

// Everything else: static file from web/dist. No spawn, no Worktree state touched.
proxy.Static(w, r, wt.Spec.WebDist)
```

Where:
```go
func isBackendPath(p string) bool {
    return strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/ws/")
}
```

This is the same convention as `web/vite.config.ts`'s dev proxy. Plugin authors only need one rule: backend routes live under `/api/*` or `/ws/*`.

### Static serving

`proxy/static.go`:
```go
func Serve(w http.ResponseWriter, r *http.Request, webDist string) {
    fs := http.Dir(webDist)
    upath := path.Clean(r.URL.Path)
    if upath == "/" { upath = "/index.html" }

    f, err := fs.Open(upath)
    if err == nil {
        defer f.Close()
        stat, _ := f.Stat()
        if !stat.IsDir() {
            http.ServeContent(w, r, upath, stat.ModTime(), f.(io.ReadSeeker))
            return
        }
    }

    // SPA fallback: paths without an extension serve index.html
    if path.Ext(upath) == "" {
        index, err := fs.Open("/index.html")
        if err != nil { http.NotFound(w, r); return }
        defer index.Close()
        stat, _ := index.Stat()
        http.ServeContent(w, r, "index.html", stat.ModTime(), index.(io.ReadSeeker))
        return
    }

    http.NotFound(w, r)
}
```

A single `http.FileServer` would work too, but the explicit version makes the SPA fallback intent obvious and avoids the trailing-slash redirect surprise.

### Cold-start sequence (`Ensure`)

Only invoked for backend paths.

1. Lock `wt.mu`.
2. Switch on state:
   - `Running` → unlock, return nil (fast path).
   - `Starting` → grab `readyCh`, unlock, `<-readyCh`, return result.
   - `Broken && now < brokenUntil` → unlock, return `ErrBroken`.
   - `Idle` or cooled-down `Broken`:
     - `port, err := portpool.Acquire()` (502 if exhausted).
     - `wt.readyCh = make(chan error, 1)`; `wt.state = Starting`; `wt.port = port`.
     - Unlock.
     - `proc, err := backend.Spawn(spec, port)`.
     - If spawn ok: `err = readiness.WaitReady(port, spec.ReadyTimeoutMs)`.
     - Relock.
     - On error: release port, kill proc if needed, `state = Broken`, `brokenUntil = now + cooldown`, send err on `readyCh`, close it.
     - On success: `wt.proc = proc`, `wt.state = Running`, `wt.proxy = newReverseProxy(port)`, `wt.lastActivity = now`, close `readyCh`.
3. Return.

Concurrent waiters all proceed to proxy or all get the same 502.

### WebSocket proxy

Stdlib `http.Hijacker` + `net.Dial` + two `io.Copy`s (~90 lines, no external dep). On upgrade: `wt.IncConns()`; on close: `wt.DecConns()`. `activeConns > 0` blocks the sweeper from tearing the backend down even after the idle window.

```go
backendConn, _ := net.DialTimeout("tcp", "127.0.0.1:"+port, 3*time.Second)
clientConn, bufrw, _ := w.(http.Hijacker).Hijack()
r.Host = backendAddr
r.Write(backendConn)
wt.IncConns(); defer wt.DecConns()
go io.Copy(backendConn, bufrw)
io.Copy(clientConn, backendConn)
```

### Idle teardown (`sweeper`)

Ticker every 30s. For each worktree under its mutex:
- `state != Running` → skip
- `activeConns > 0` → skip
- `now - lastActivity < cfg.IdleTimeout` → skip
- Otherwise: `state = Stopping`, snapshot `proc`/`port`, unlock, run shutdown.

Shutdown: `SIGTERM`, wait up to `cfg.ShutdownGrace` (5s), then `SIGKILL`. Release port. Relock and reset `proc`/`proxy`/`port` to zero, `state = Idle`.

Crash mid-life triggers the same cleanup via the `Wait` goroutine, transitioning to `Idle`.

### Activity tracking — only backend hits count

`lastActivity` is updated only when a request is actually proxied to the backend (HTTP `/api/*`, HTTP `/ws/*` non-upgrade, or WebSocket upgrade/close). Static hits do **not** touch it.

Rationale: a static page served by the gateway has nothing to do with the backend. A user with a tab open who isn't interacting shouldn't keep an unused backend warm. The lazy-spawn architecture exists to free idle resources; counting passive page views as activity would defeat it. Real usage (clicking something, opening the terminal) is what should keep the backend alive — and it will, because every such interaction goes through `/api/*` or `/ws/*` and resets the timer.

This is a deliberate change from v1 (which proposed counting static hits as activity, in the context of Model B where statics went through the backend anyway). With the static path now bypassing the backend entirely, that reasoning no longer applies.

---

## Gateway API (`/gateway/*`)

Reserved on every host. Apps can call this from any worktree without knowing a special hostname.

**v1 ships**:
```
GET /gateway/worktrees
  → 200 application/json
  [
    {
      "name": "head",
      "state": "running",
      "port": 9042,
      "lastActivity": "2026-04-09T14:32:11Z",
      "activeConns": 1,
      "worktreeDir": "/Users/me/src/singularity"
    },
    ...
  ]
```

This is the endpoint the future dashboard plugin will consume.

**Future** (designed but not implemented v1):
```
GET  /gateway/worktrees/{name}        # details for one
POST /gateway/worktrees/{name}/stop   # force teardown
GET  /gateway/health                  # gateway self-health
GET  /gateway/me                      # info about the worktree the request came in on
```

The API is intentionally non-internal-looking (`/gateway/`, no underscores) — it's an official extension surface.

---

## Host parsing

```go
func parseWorktree(host string) string {
    h := stripPort(host)
    h = strings.ToLower(h)
    h = strings.TrimSuffix(h, ".")

    switch h {
    case "localhost", "127.0.0.1", "::1", "[::1]":
        return ""
    }

    if !strings.HasSuffix(h, ".localhost") {
        return ""
    }
    name := strings.TrimSuffix(h, ".localhost")
    if strings.Contains(name, ".") {
        return ""
    }
    return name
}
```

`head` is **not special-cased** in code. It's just a worktree named `head` in the registry. The router has one tiny exception: the no-subdomain case redirects to `head.localhost:9000` if registered (so users typing `localhost:9000` land somewhere useful).

---

## Discovery & file watching

**Startup**: scan `~/.singularity/worktrees/*.json`, decode, `registry.Upsert` each.

**Watcher** (fsnotify on `~/.singularity/worktrees/`):
- `CREATE`/`WRITE` `<name>.json` → re-read, `Upsert`. 100ms debounce for editors that write-rename-close.
- `REMOVE` `<name>.json` → `Remove(name)`.

**Spec change while running**: store as `pendingSpec`. Sweeper triggers a graceful restart at the next idle window (or immediately if `activeConns == 0`). Surprise-killing a running backend would yank active WS sessions.

**Important**: a spec change that only modifies `webDist` does NOT require a backend restart — statics are read fresh on every request from disk. Only changes affecting the backend (cwd, command, env, portEnv) trigger restart logic.

---

## Configuration

Flags via stdlib `flag`:

```
--listen <addr>          Default ":9000".
--idle-timeout <dur>     Default "10m".
--shutdown-grace <dur>   Default "5s".
--ready-timeout <dur>    Default "15s" (fallback if paths spec omits).
--port-min <int>         Default 9001.
--port-max <int>         Default 10000.
--sweep-interval <dur>   Default "30s".
--broken-cooldown <dur>  Default "10s".
--log-level <str>        Default "info".
--log-format <str>       Default "text". {"text","json"}
```

Registry path is fixed to `~/.singularity/worktrees/`.

`main.go`: parse → validate → wire components → `http.Server{ReadHeaderTimeout: 10s}` → `signal.NotifyContext` for SIGINT/SIGTERM → on signal, `srv.Shutdown(ctx)` then iterate registry and stop every running backend.

---

## Logging

- One slog line per HTTP request after completion: `method host path status bytes latency_ms worktree route_kind cold_start?` where `route_kind` ∈ `{"static","backend","ws","gatewayapi"}`.
- Backend stdout/stderr piped through `logx`, each line emitted with `worktree=<name> stream=stdout|stderr`.
- Lifecycle events (spawn start/ready/fail, idle teardown, crash, port acquire/release, watcher upsert/remove) at info or warn.
- Default text format (this is a local dev tool); JSON behind `--log-format`.

Metrics endpoint is **out of scope for v1**.

---

## Edge cases

| Case | Handling |
|---|---|
| Spawn fails | Release port, `Broken`, `brokenUntil = now + cooldown`, 502. |
| Readiness times out | Kill proc, release port, `Broken`. Log timeout so user can tune. |
| Port pool exhausted | 503. Does not mark Broken (systemic). |
| Port collision with external process | `Acquire` probes via `net.Listen` first; skips busy ports. |
| Backend crashes mid-HTTP | `ReverseProxy.ErrorHandler` returns 502; `Wait` goroutine transitions state to `Idle`. |
| Backend crashes mid-WS | Both `io.Copy`s error, `DecConns`, state → `Idle` on next `Wait` fire. |
| Backend hangs on SIGTERM | Grace expires → SIGKILL. |
| Concurrent cold-start callers | First owns spawn; others block on `readyCh`. |
| Spec updated while running (backend fields) | Stored as `pendingSpec`; sweeper triggers graceful restart. |
| Spec updated while running (only `webDist`) | Updated immediately, no restart — statics read fresh per request. |
| Spec deleted while running | Graceful stop, then registry removal. |
| Unknown worktree | 404. |
| `webDist` directory missing | Static handler returns 404 per request. Worktree still listed in registry. |
| `webDist/index.html` missing | SPA fallback 404s. Direct `/index.html` request 404s. |
| Caller cancels mid-spawn | Their context errors, but spawn continues for other waiters. |
| Backend emits absolute redirects | Documented constraint: backends MUST use relative redirects. Gateway does not rewrite `Location`. |
| Trailing dot in Host | Stripped before parsing. |
| Uppercase host | Lowercased; registry keys are lowercase too. |
| WS connection across idle window | `activeConns > 0` gates teardown — safe. |
| Gateway SIGTERM | `srv.Shutdown` → stop all backends with grace → release all ports → exit 0. |
| User kills backend manually | `Wait` observes, state → `Idle`, port released, next request respawns. |
| Static path shadows `/api/foo` (e.g., a file at `web/dist/api/foo`) | `isBackendPath` is checked first; backend path always wins. Files under `web/dist/api/` are unreachable. Document. |
| Browser requests `localhost:9000/` | Redirect to `head.localhost:9000` if head registered, else 404. |

---

## Implementation sequencing

Each step leaves the gateway in a runnable state.

1. `cmd/gateway` + `config` + `logx` — bootable stub that prints config.
2. `portpool` — standalone, unit-testable.
3. `registry` + `paths` — in-memory only, no spawn yet. Hand-populate via test.
4. `discovery` — fsnotify loop feeding registry.
5. `proxy/router` + `proxy/static` + `gatewayapi` — gateway serves statics and `/gateway/worktrees` from registry. Backends still not spawned. **End-to-end usable for static-only worktrees.**
6. `backend` + `readiness` — spawn + wait + stop, no proxy integration yet.
7. `proxy/http` — wire `httputil.ReverseProxy` through `Ensure`. Backend cold-start works for `/api/*`.
8. `proxy/ws` — hijack proxy + activeConns bookkeeping.
9. `sweeper` — idle teardown.
10. End-to-end manual test with two fake worktrees running trivial Go HTTP servers.
11. Wire to real equin backend after `server/src/index.ts` reads `PORT` from env (one-line change).

---

## Verification

End-to-end manual test:

1. Build the gateway: `cd gateway && go build -o gateway ./cmd/gateway`.
2. Build the web bundle: `cd web && bun run build`.
3. Make `server/src/index.ts` read `PORT` from env (one-line change).
4. Hand-write `~/.singularity/worktrees/head.json` pointing at the head checkout's `web/dist` and `server/`.
5. Hand-write `~/.singularity/worktrees/feature-x.json` pointing at a sibling worktree.
6. `./gateway/gateway`.
7. Browser checks:
   - `http://localhost:9000/` → 302 to `head.localhost:9000`.
   - `http://head.localhost:9000/` → SPA loads instantly. **No backend spawned yet** (verify: no bun process, no log line).
   - Open the terminal in the SPA → `/ws/terminal` triggers cold-start (~1-2s log line), then terminal works.
   - `http://feature-x.localhost:9000/` → independent SPA loads instantly, again no spawn.
   - `curl http://head.localhost:9000/gateway/worktrees` → JSON list showing both worktrees, head as `running`, feature-x as `idle`.
8. Idle test: leave the terminal disconnected for 11 minutes. Watch sweeper logs. Backend torn down. Refreshing the SPA still works (no spawn). Re-opening the terminal cold-starts the backend.
9. Kill the backend manually: `kill <pid>`. SPA still loads. Re-opening terminal respawns.
10. Update `head.json`'s backend command → watcher logs detection, marks pendingSpec, restarts at next idle.
11. Update `head.json`'s `webDist` to a different directory → next page load serves from new dir, no restart.
12. Delete `feature-x.json` → vanishes from `/gateway/worktrees`, backend (if any) stopped.

---

## Critical files to be created

- `gateway/cmd/gateway/main.go`
- `gateway/internal/registry/registry.go`
- `gateway/internal/registry/paths.go`
- `gateway/internal/backend/backend.go`
- `gateway/internal/backend/readiness.go`
- `gateway/internal/proxy/router.go`
- `gateway/internal/proxy/http.go`
- `gateway/internal/proxy/ws.go`
- `gateway/internal/proxy/static.go`
- `gateway/internal/discovery/watcher.go`
- `gateway/internal/sweeper/sweeper.go`
- `gateway/internal/gatewayapi/api.go`
- `gateway/internal/portpool/portpool.go`
- `gateway/internal/config/config.go`
- `gateway/internal/logx/logx.go`

## Files affected outside the gateway (separate, follow-up tasks)

- `server/src/index.ts` — read `PORT` from `Bun.env.PORT` instead of hardcoding `9001`. One line.
- `plugins/terminal/web/components/terminal.tsx` — drop hardcoded `ws://localhost:9001`, use relative `/ws/terminal` so the gateway routes it via the worktree's subdomain.
- `web/vite.config.ts` — dev proxy may want to point at the gateway instead of `localhost:9001` directly. Optional.
- Future: dashboard plugin (frontend) consuming `GET /gateway/worktrees`.

These are tracked separately and not part of this design.
