# Gateway Design

## Context

equin lets users run multiple isolated instances of the agent-manager app — one per agent worktree — and switch between them seamlessly. v1 (at the user's previous company) used path-prefix routing (`localhost:9000/<worktree>/...`) because the core app couldn't be modified. equin owns the whole stack, so we can do better.

This design specifies a Go reverse-proxy gateway that:
1. Listens on `:9000` and routes `<worktree>.localhost:9000` → that worktree's backend.
2. Owns backend process lifecycles: spawns lazily on first request, tears down after 10 minutes idle.
3. Allocates backend ports dynamically; backends never know the gateway exists.
4. Discovers worktrees via JSON files in `~/.singularity/worktrees/`.
5. Serves a dashboard at `localhost:9000/` listing active worktrees.
6. Exposes `/gateway/*` on every host as an official API for apps to query gateway state.

The CLI (`.singularity build`), terminal hardcoded-URL fix, and any backend-side static-serving changes are **out of scope**. This doc is the gateway only.

---

## Architecture overview

```
                ┌──────────────────────────────────────────┐
   Browser ───▶ │   Gateway (Go) on :9000                  │
                │                                          │
                │   ┌─ Host parser ─ subdomain → name      │
                │   ├─ /gateway/* → gateway API            │
                │   ├─ no subdomain → dashboard            │
                │   └─ <name>.localhost → registry lookup  │
                │            │                             │
                │            ▼                             │
                │      Ensure(name) (lazy spawn)           │
                │            │                             │
                │            ▼                             │
                │      ReverseProxy or WS hijack           │
                └────────────┬─────────────────────────────┘
                             │
                  proxied to 127.0.0.1:<allocated-port>
                             │
                ┌────────────▼──────────────┐
                │  Backend (bun, owned by   │
                │  gateway, spawned on      │
                │  demand, killed when idle)│
                │                           │
                │  Serves BOTH /api/*,      │
                │  /ws/*, AND web/dist      │
                │  static assets            │
                └───────────────────────────┘
```

**Key design principle**: the gateway is pure network/process plumbing. It never reads `web/dist`, never parses HTML, knows nothing about plugins or protocols. The backend is responsible for serving everything for its instance — statics + API + WebSocket. This keeps responsibilities clean: one process per instance owns everything.

Cold-start cost (~1–2s with Bun) is the accepted trade-off for that simplicity.

---

## Registry: file format and location

**Location**: `~/.singularity/worktrees/<name>.json` (user-global, single source of truth across the machine — chosen so multiple equin checkouts can coexist without duplicated registration).

**Format**:
```json
{
  "name": "head",
  "worktreeDir": "/Users/me/src/singularity",
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
| `name` | yes | Must match the filename and `^[a-z0-9][a-z0-9-]{0,62}$` (DNS-label safe). Filename is authoritative; `name` is a sanity check. |
| `worktreeDir` | yes | Informational; shown on dashboard. |
| `backend.cwd` | yes | Working directory for `exec.Cmd`. Absolute. |
| `backend.command` | yes | argv for the child. Not a shell string. |
| `backend.env` | no | Extra env vars merged on top of gateway's env. |
| `backend.portEnv` | no | Default `"PORT"`. Env var the backend reads to pick its port. |
| `backend.readyTimeoutMs` | no | Default `15000`. Max wait for TCP readiness before declaring spawn failure. |

The build CLI (out of scope) is responsible for writing these files. For day-1 use, hand-write `~/.singularity/worktrees/head.json`.

**Note**: backends must serve their own `web/dist`. The current `server/src/index.ts` doesn't do this — it'll need an update before the gateway is usable. That change is tracked separately.

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
    │   └── paths.go                 (~60)
    ├── discovery/watcher.go         (~140)
    ├── portpool/portpool.go         (~70)
    ├── backend/
    │   ├── backend.go               (~220)
    │   └── readiness.go             (~40)
    ├── proxy/
    │   ├── router.go                (~120)
    │   ├── http.go                  (~60)
    │   └── ws.go                    (~90)
    ├── gatewayapi/api.go            (~80)
    ├── dashboard/
    │   ├── dashboard.go             (~60)
    │   └── templates/index.html     (embedded)
    ├── sweeper/sweeper.go           (~60)
    └── logx/logx.go                 (~40)
```

Roughly **~1200 lines** of Go for v1.

### Per-package responsibilities

- **cmd/gateway/main.go** — flag parsing, wire components, signal handling, `http.Server.ListenAndServe`.
- **config** — flags + defaults. Pure value type.
- **registry** — in-memory, thread-safe map of `Worktree` state. Owns the per-worktree state machine.
- **discovery** — fsnotify loop on `~/.singularity/worktrees/`, feeds the registry.
- **portpool** — free-list allocator for ports 9001–10000 with `net.Listen` probe to skip busy ports.
- **backend** — process supervision (spawn, wait, stop, stdout/stderr pumps).
- **proxy/router** — top-level `http.Handler`. Parses Host, dispatches to gatewayapi / dashboard / backend proxy.
- **proxy/http** — `httputil.ReverseProxy` instances per worktree, cached.
- **proxy/ws** — WebSocket proxy via `http.Hijacker` + two `io.Copy`s (~90 lines, no external lib). Bumps `activeConns` for the duration.
- **gatewayapi** — handlers for `/gateway/*`. v1 ships `GET /gateway/worktrees` (JSON list).
- **dashboard** — server-side renders an embedded HTML template, auto-refresh via `<meta refresh>`. No JS.
- **sweeper** — ticker goroutine that scans the registry and tears down idle backends.
- **logx** — thin wrapper over `log/slog` with `WithWorktree(name)`.

---

## Internal data model

```go
// registry/registry.go

type State int
const (
    StateIdle     State = iota // known but no process
    StateStarting              // spawning, readiness pending
    StateRunning               // serving traffic
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
    lastActivity time.Time
    activeConns  int                       // in-flight HTTP + open WS
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

if worktree == "" {
    dashboard.Handle(w, r)
    return
}

wt := registry.Get(worktree)
if wt == nil {
    http.NotFound(w, r)                       // "unknown worktree: <name>"
    return
}

if err := wt.Ensure(ctx); err != nil {
    http.Error(w, err.Error(), 502)
    return
}

if isWebSocketUpgrade(r) {
    proxy.WS(w, r, wt)
} else {
    wt.Proxy().ServeHTTP(w, r)
}

wt.Touch()                                    // every request resets idle timer
```

### Cold-start sequence (`Ensure`)

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

Stdlib `http.Hijacker` + `net.Dial` + two `io.Copy`s (~90 lines, no external dep). On upgrade: `wt.IncConns()`; on close: `wt.DecConns()`. Both wrap `Touch()` under `wt.mu`. `activeConns > 0` blocks the sweeper from tearing the backend down even after the idle window.

Sketch:
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

A backend crashing mid-life triggers the same cleanup via the `Wait` goroutine, transitioning to `Idle` (not `Broken`; only spawn failures produce `Broken`).

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
    h := stripPort(host)              // handles IPv6 brackets too
    h = strings.ToLower(h)
    h = strings.TrimSuffix(h, ".")    // strip trailing dot

    switch h {
    case "localhost", "127.0.0.1", "::1", "[::1]":
        return ""                     // dashboard
    }

    if !strings.HasSuffix(h, ".localhost") {
        return ""                     // unknown host → dashboard
    }
    name := strings.TrimSuffix(h, ".localhost")
    if strings.Contains(name, ".") {
        return ""                     // reject foo.bar.localhost
    }
    return name
}
```

`head` is **not special-cased** in code. It's just a worktree named `head` in the registry. The dashboard sorts it first for UX, but the data path treats it identically.

---

## Discovery & file watching

**Startup**: scan `~/.singularity/worktrees/*.json`, decode, `registry.Upsert` each.

**Watcher** (fsnotify on `~/.singularity/worktrees/`):
- `CREATE`/`WRITE` `<name>.json` → re-read, `Upsert`. 100ms debounce for editors that write-rename-close.
- `REMOVE` `<name>.json` → `Remove(name)`.

**Spec change while running**: store as `pendingSpec`. Sweeper triggers a graceful restart at the next idle window (or immediately if `activeConns == 0`). Surprise-killing a running backend would yank active WS sessions.

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

Registry path is fixed to `~/.singularity/worktrees/` (no flag — single source of truth is the whole point).

`main.go`: parse → validate → wire components → `http.Server{ReadHeaderTimeout: 10s}` → `signal.NotifyContext` for SIGINT/SIGTERM → on signal, `srv.Shutdown(ctx)` then iterate registry and stop every running backend.

---

## Logging

- One slog line per HTTP request after completion: `method host path status bytes latency_ms worktree cold_start?`.
- Backend stdout/stderr piped through `logx`, each line emitted with `worktree=<name> stream=stdout|stderr`.
- Lifecycle events (spawn start/ready/fail, idle teardown, crash, port acquire/release, watcher upsert/remove) at info or warn.
- Default text format (this is a local dev tool); JSON behind `--log-format`.

Metrics endpoint is **out of scope for v1**. Easy to add later on a separate admin listener.

---

## Edge cases

| Case | Handling |
|---|---|
| Spawn fails | Release port, `Broken`, `brokenUntil = now + cooldown`, 502. |
| Readiness times out | Kill proc, release port, `Broken`. Log timeout so user can tune. |
| Port pool exhausted | 503 (systemic, not per-worktree). |
| Port collision with external process | `Acquire` probes via `net.Listen` first; skips busy ports. |
| Backend crashes mid-HTTP | `ReverseProxy.ErrorHandler` returns 502; `Wait` goroutine transitions state to `Idle`. |
| Backend crashes mid-WS | Both `io.Copy`s error, `DecConns`, state → `Idle` on next `Wait` fire. |
| Backend hangs on SIGTERM | Grace expires → SIGKILL. |
| Concurrent cold-start callers | First owns spawn; others block on `readyCh`. |
| Spec updated while running | Stored as `pendingSpec`; sweeper triggers graceful restart. |
| Spec deleted while running | Same: graceful stop, then registry removal. |
| Unknown worktree | 404 from router. |
| Caller cancels mid-spawn | Their context errors, but spawn continues for other waiters. |
| Backend emits absolute redirects | **Documented constraint**: backends MUST use relative redirects. The gateway does not rewrite `Location` headers. |
| Trailing dot in Host | Stripped before parsing. |
| Uppercase host | Lowercased; registry keys are lowercase too. |
| Same WS connection across idle window | `activeConns > 0` gates teardown — safe. |
| Gateway SIGTERM | `srv.Shutdown` → stop all backends with grace → release all ports → exit 0. |
| User kills backend manually | `Wait` observes, state → `Idle`, port released, next request respawns. |

---

## Implementation sequencing

Each step leaves the gateway in a runnable state.

1. `cmd/gateway` + `config` + `logx` — bootable stub that prints config.
2. `portpool` — standalone, unit-testable.
3. `registry` + `paths` — in-memory only, no spawn yet. Hand-populate via test.
4. `discovery` — fsnotify loop feeding registry.
5. `dashboard` + `gatewayapi` — gateway serves dashboard and `/gateway/worktrees` from registry. Backends still not spawned.
6. `proxy/router` — host parsing, routing decision tree.
7. `backend` + `readiness` — spawn + wait + stop, no proxy integration yet.
8. `proxy/http` — wire `httputil.ReverseProxy` through `Ensure`.
9. `proxy/ws` — hijack proxy + activeConns bookkeeping.
10. `sweeper` — idle teardown.
11. End-to-end manual test with two fake worktrees running trivial Go HTTP servers.
12. Wire to real equin backend after `server/` learns to serve `web/dist` (separate task).

---

## Verification

End-to-end manual test:

1. Build the gateway: `cd gateway && go build -o gateway ./cmd/gateway`.
2. Hand-write `~/.singularity/worktrees/head.json` pointing at the head checkout's `server/`.
3. Hand-write `~/.singularity/worktrees/feature-x.json` pointing at a sibling worktree.
4. `./gateway/gateway` (or via `go run`).
5. Browser checks:
   - `http://localhost:9000/` → dashboard lists `head` (idle) and `feature-x` (idle).
   - `http://head.localhost:9000/` → dashboard reloads after backend spawn (~2s); subsequent loads instant.
   - `http://head.localhost:9000/api/...` → JSON response from backend.
   - `http://head.localhost:9000/ws/terminal` → terminal works.
   - `http://feature-x.localhost:9000/` → independent backend on different port.
6. `curl http://head.localhost:9000/gateway/worktrees` → JSON list.
7. Idle test: leave for 11 minutes, watch sweeper logs, confirm backend torn down. Next request cold-starts.
8. Kill backend manually: `kill <pid>`; refresh page; gateway respawns.
9. Update `head.json` → watcher logs detection, backend restarted on next idle.
10. Delete `feature-x.json` → vanishes from dashboard, process stopped.

---

## Critical files to be created

- `gateway/cmd/gateway/main.go`
- `gateway/internal/registry/registry.go`
- `gateway/internal/backend/backend.go`
- `gateway/internal/proxy/router.go`
- `gateway/internal/proxy/ws.go`
- `gateway/internal/discovery/watcher.go`
- `gateway/internal/sweeper/sweeper.go`
- `gateway/internal/gatewayapi/api.go`
- `gateway/internal/dashboard/dashboard.go`

## Files affected outside the gateway (separate, follow-up tasks)

- `server/src/index.ts` — must learn to serve `web/dist` static files (because we chose Model B). Also needs to read `PORT` env var instead of hardcoding 9001.
- `plugins/terminal/web/components/terminal.tsx` — drop hardcoded `ws://localhost:9001`, use relative `/ws/terminal`.
- `web/vite.config.ts` — dev proxy will need to point at the gateway (or stay pointed at a single backend for plugin dev).
- `.gitignore` — no change needed; registry lives in `~/.singularity/`, not the repo.

These are tracked separately and not part of this design.
