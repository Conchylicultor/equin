# Gateway Design — v3

This iteration is a simplification pass on [v2](2026-04-09-gateway-design-v2.md). Two things change:

1. **`paths.json` is shrunk to two fields.** Filename is the worktree identifier (no redundant `name`). The gateway hardcodes how to launch the backend; only the directory is needed.
2. **Package layout flattens to 5 files at the top level.** No more `internal/<sub>/<file>.go` nesting. Helpers like `logx` and a separate `gatewayapi` package are dropped — they were ceremony, not abstraction.

Everything else from v2 stands as written. Cross-references below.

---

## Context

Unchanged from [v2 §Context](2026-04-09-gateway-design-v2.md#context). The gateway is a Go reverse proxy on `:9000` that:
- Routes `<worktree>.localhost:9000` → that worktree
- Serves each worktree's `web/dist` directly from the filesystem
- Lazy-spawns the backend on first `/api/*` or `/ws/*` request, kills it after 10 minutes idle
- Allocates backend ports dynamically
- Discovers worktrees via JSON files in `~/.singularity/worktrees/`
- Exposes `/gateway/*` on every host as an official API

Architecture diagram: see [v2 §Architecture overview](2026-04-09-gateway-design-v2.md#architecture-overview).

---

## Registry: file format and location

**Location**: `~/.singularity/worktrees/<name>.json`. The filename is the worktree identifier. There is no `name` field in the JSON — the file *is* its name.

**Format** (the entire schema):

```json
{
  "server": "/Users/me/src/singularity/server",
  "web":    "/Users/me/src/singularity/web/dist"
}
```

| Field | Required | Constraint | Purpose |
|---|---|---|---|
| `server` | yes | absolute path to a directory | Working directory the backend is launched in. |
| `web`    | yes | absolute path to a directory containing `index.html` | Served as static files by the gateway. |

**That's it.** Both required. No optional fields. No nested objects. No defaults to remember.

### What the gateway hardcodes

By owning the launch convention rather than reading it from a file, every worktree behaves the same way and the JSON stays trivial:

- **Command**: `bun src/index.ts`, run from the `server` directory.
- **Env**: inherit gateway's env, plus `PORT=<allocated>`.
- **Ready timeout**: 15s, configurable globally via `--ready-timeout` (not per worktree).
- **Filename → name**: `head.json` → `head.localhost:9000`. Filename must match `^[a-z0-9][a-z0-9-]{0,62}$`; files that don't are skipped with a warning at load time.

If a worktree ever needs a different launch command, env var, or timeout, that's a future extension to the schema. For v1, there is no use case for it: equin owns the whole stack and every worktree is a checkout of the same codebase. Adding flexibility now is speculative.

### Validation

At upsert time:
- Both fields present and non-empty → otherwise log warning, skip.
- Both fields absolute paths → otherwise log warning, skip.
- Filename matches the regex → otherwise log warning, skip.

We do **not** stat the directories at load time. A missing `server/` becomes a spawn failure (502, marked Broken). A missing `web/` becomes a 404 from the static handler. These errors are visible in the right place at the right time, no preflight check needed.

### Required server-side change

The current `server/src/index.ts` hardcodes `port: 9001`. It must read from env:
```ts
port: parseInt(Bun.env.PORT ?? "9001", 10)
```
That's the only required change in the existing codebase. Tracked separately.

---

## Go package layout

Single package, flat. Five Go files at the top level, no `internal/`, no sub-packages.

```
gateway/
├── go.mod
├── go.sum
├── README.md
├── main.go        (~100)  flags, wiring, signal handling
├── worktree.go    (~280)  Worktree struct + state machine + spawn + readiness + lifecycle
├── registry.go    (~230)  Registry struct + file load + fsnotify watcher + idle sweeper
├── proxy.go       (~280)  HTTP handler: routing, static, HTTP proxy, WS hijack, /gateway API
└── ports.go       (~60)   port pool
```

**Total ~950 lines.** Down from ~1250 in v2's 14-file layout. The reduction is entirely structural — same functionality, less ceremony.

### Why this layout

Per the api-design skill, **logic belongs with the data it operates on** and you should **question whether each abstraction is justified**. Applied:

- **`worktree.go`** owns everything that touches a single backend's state: the `Worktree` struct, its mutex, its state machine, its `Ensure`/`Stop`/`Touch`/`IncConns`/`DecConns` methods, the spawn helper, the TCP readiness probe, the stdout/stderr pumps. v2 had this split across `registry/registry.go`, `backend/backend.go`, and `backend/readiness.go`. Splitting it created package boundaries inside what is conceptually one cohesive thing — the lifecycle of a backend process. Collapsing it makes the state machine readable in one file.

- **`registry.go`** owns the *collection* of worktrees: the map, the fsnotify watcher that populates it, and the sweeper goroutine that walks it for idle teardown. The sweeper was a separate package in v2 — but it operates exclusively on the registry, so it lives with the registry. Same for discovery: the watcher's whole job is calling `Upsert`/`Remove` on the registry. Three things, one file, one concern: "the set of worktrees and how it changes over time."

- **`proxy.go`** is the HTTP entry point: host parsing, routing decision tree, static file serving, the cached `httputil.ReverseProxy` instances, the WebSocket hijack handler, and the `/gateway/*` API handlers. v2 had four separate files for these (`router.go`, `http.go`, `ws.go`, `static.go`) plus a `gatewayapi` package. But they're all "request comes in → decide what to do → write response" — the natural unit is one file. The WebSocket proxy is the longest piece (~80 lines) but it doesn't need its own file; it's a function in `proxy.go` like the others.

- **`ports.go`** stays separate because the port pool is genuinely independent of everything else and is small enough to be obvious. It could merge into `registry.go` if you wanted four files instead of five — judgment call.

- **`main.go`** is the entry point: parse flags into a config struct (defined inline, no separate `config` package), construct a `Registry`, register the proxy handler, install signal handlers, run `http.Server.ListenAndServe`. ~100 lines.

### What got dropped

| v2 element | Status in v3 | Why |
|---|---|---|
| `internal/config/config.go` | Inlined into `main.go` | A 60-line file for `type Config struct {...}` plus flag parsing is over-organized. Keep flags next to the place they're consumed. |
| `internal/logx/logx.go` | Deleted | A wrapper over `slog` adds nothing. Use `slog` directly. |
| `internal/gatewayapi/api.go` | Function in `proxy.go` | One JSON endpoint doesn't need a package. |
| `internal/dashboard/` | Already removed in v2 | Dashboard is a frontend plugin. |
| `internal/discovery/watcher.go` | Function in `registry.go` | The watcher exists to mutate the registry. Same file. |
| `internal/sweeper/sweeper.go` | Function in `registry.go` | Same: it iterates the registry. |
| `internal/backend/backend.go` | Methods on `Worktree` in `worktree.go` | Spawn/Stop/readiness are part of the worktree lifecycle, not a separate concern. |
| `internal/backend/readiness.go` | Function in `worktree.go` | A 40-line TCP-dial loop doesn't justify a file. |
| `internal/proxy/{router,http,ws,static}.go` | All in `proxy.go` | Same concern (handle HTTP request); splitting created artificial boundaries. |
| `internal/registry/{registry,paths}.go` | One file, plus inline JSON parsing | `paths.go` is now ~15 lines of struct + decode. Inline. |

The principle: each file is a **feature**, not a class. v2 was organizing by class-per-file (Java/Python habit). Go prefers package-per-feature.

### What stays from v2

- **Internal data model** (Worktree struct, State enum, mutex strategy): unchanged. See [v2 §Internal data model](2026-04-09-gateway-design-v2.md#internal-data-model). The struct just lives in `worktree.go` instead of `internal/registry/registry.go`. Tweak: `Spec` becomes the simpler 2-field struct described above.

- **Routing decision tree** (`/gateway/*` first, then `isBackendPath`, then static, with no-subdomain redirect to `head.localhost:9000`): unchanged. See [v2 §Request flow](2026-04-09-gateway-design-v2.md#request-flow). Now lives in `proxy.go`.

- **Cold-start `Ensure` algorithm** (state machine, `readyCh` for concurrent waiters, port acquire/release, broken cooldown): unchanged. See [v2 §Cold-start sequence](2026-04-09-gateway-design-v2.md#cold-start-sequence-ensure). Method on `Worktree` in `worktree.go`.

- **WebSocket hijack proxy** (~80 lines, stdlib only, increments `activeConns`): unchanged. See [v2 §WebSocket proxy](2026-04-09-gateway-design-v2.md#websocket-proxy). Function in `proxy.go`.

- **Static serving** (`http.ServeContent` with SPA fallback for extensionless paths): unchanged. See [v2 §Static serving](2026-04-09-gateway-design-v2.md#static-serving). Function in `proxy.go`.

- **Idle teardown algorithm** (30s sweep, skip if `activeConns > 0` or within idle window, SIGTERM → grace → SIGKILL, release port): unchanged. See [v2 §Idle teardown](2026-04-09-gateway-design-v2.md#idle-teardown-sweeper). Function in `registry.go`.

- **Activity tracking** (only backend hits update `lastActivity`; static hits don't): unchanged. See [v2 §Activity tracking — only backend hits count](2026-04-09-gateway-design-v2.md#activity-tracking--only-backend-hits-count).

- **Port pool** (free-list, `net.Listen` collision probe, 9001-10000 default): unchanged. See [v2 §portpool](2026-04-09-gateway-design-v2.md#per-package-responsibilities). Now `ports.go`.

- **Discovery & file watching** (fsnotify on the registry dir, debounced upsert, `pendingSpec` for graceful restart): unchanged. See [v2 §Discovery & file watching](2026-04-09-gateway-design-v2.md#discovery--file-watching). Function in `registry.go`.

- **Host parsing** (subdomain extraction, lowercase, trailing dot strip, IPv6 handling): unchanged. See [v2 §Host parsing](2026-04-09-gateway-design-v2.md#host-parsing).

- **Gateway API** (`GET /gateway/worktrees`, future endpoints): unchanged. See [v2 §Gateway API](2026-04-09-gateway-design-v2.md#gateway-api-gateway). Function in `proxy.go`.

- **Configuration flags** (`--listen`, `--idle-timeout`, etc.): unchanged. See [v2 §Configuration](2026-04-09-gateway-design-v2.md#configuration). Parsed in `main.go`.

- **Logging**: unchanged. See [v2 §Logging](2026-04-09-gateway-design-v2.md#logging). Use `log/slog` directly, no wrapper.

- **Edge cases table**: unchanged. See [v2 §Edge cases](2026-04-09-gateway-design-v2.md#edge-cases).

---

## Implementation sequencing

Each step leaves the gateway in a runnable state. Same intent as v2 but with the flat layout there are fewer files to scaffold.

1. `main.go` + `ports.go` — bootable stub that prints config and exposes a hello-world handler.
2. `registry.go` — file load + fsnotify watcher feeding an in-memory map. Verify by running against a fake `~/.singularity/worktrees/`.
3. `proxy.go` static + `/gateway/worktrees` paths — gateway serves statics for any registered worktree and JSON list. Backends still not spawned. **End-to-end usable for static-only worktrees.**
4. `worktree.go` — `Worktree` struct, spawn, readiness, stop. No proxy integration yet.
5. `proxy.go` HTTP backend proxy — wire `httputil.ReverseProxy` through `Worktree.Ensure`. Backend cold-start works for `/api/*`.
6. `proxy.go` WS hijack + `activeConns` bookkeeping.
7. `registry.go` sweeper — idle teardown.
8. End-to-end manual test with two fake worktrees running trivial Go HTTP servers.
9. Wire to real equin backend after `server/src/index.ts` reads `PORT` from env.

---

## Verification

Same as [v2 §Verification](2026-04-09-gateway-design-v2.md#verification), but `paths.json` is now the simpler two-field schema:

```json
{
  "server": "/Users/me/src/singularity/server",
  "web":    "/Users/me/src/singularity/web/dist"
}
```

And the verification step `Hand-write ~/.singularity/worktrees/head.json pointing at the head checkout's web/dist and server/` becomes just that — two paths, one filename.

---

## Critical files to be created

- `gateway/main.go`
- `gateway/worktree.go`
- `gateway/registry.go`
- `gateway/proxy.go`
- `gateway/ports.go`
- `gateway/go.mod`
- `gateway/README.md`

## Files affected outside the gateway

Unchanged from [v2 §Files affected outside the gateway](2026-04-09-gateway-design-v2.md#files-affected-outside-the-gateway-separate-follow-up-tasks). The only required external change is the one-line `PORT` env read in `server/src/index.ts`. Terminal hardcoded URL fix, dev proxy update, and dashboard plugin remain follow-up work.
