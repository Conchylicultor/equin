# 01 — Topology & Transport: Gateway, Sockets, Processes

> Part of the [communications audit](./00-overview.md). This file covers the
> physical transport layer: which processes exist, who spawns them, and how a
> byte gets from a browser to a backend and back.

## 1. The processes

| Process | Runtime | Cardinality | Spawned by | Listens on |
|---|---|---|---|---|
| Gateway | Go | 1 per machine | `./equin start` (one-time), self-daemonizing | TCP `:9000` (the only public listener) |
| Worktree backend | Bun (TS) | 1 per worktree (incl. `main` → `singularity` namespace) | Gateway (lazy, on first request or on build notify) | Unix socket `~/.singularity/sockets/<name>.sock` |
| Central backend | Bun (TS) | 1 per machine | Gateway | Unix socket (same scheme, name `central`) |
| Postgres 18 | native | 1 cluster per machine | Gateway supervisor (via `database/embedded/scripts/start.ts`) | TCP `127.0.0.1:5433` + Unix socket dir |
| PgBouncer | native | 1 per machine | Gateway supervisor (via `database/pgbouncer/scripts/start.ts`) | TCP `:6432` + Unix socket |
| zero-cache | Node | 1 per worktree (opt-in pilot, `SINGULARITY_ZERO_CACHE`) | Gateway (lazy) | loopback TCP `:4848`-family |
| Claude agent sessions | tmux + CLI | N | conversations plugin (`runtime-tmux`) | — (communicate via transcript files + MCP HTTP) |

Postgres and PgBouncer **daemonize and outlive** gateway/build restarts; the
gateway reattaches via pidfile + socket probe instead of double-spawning.
The supervisor's config lives in `~/.singularity/database.json` (services
with `start`/`ready`/`watchdog` entries; 2s watchdog probe with one restart
attempt).

## 2. Gateway request routing (`gateway/proxy.go`)

Every browser request hits `Proxy.ServeHTTP`, which dispatches in this exact
order:

1. **Worktree from Host header**: `<name>.localhost:9000` → `<name>`. Bare
   `localhost` / IPs / multi-label hosts → no worktree.
2. **`/gateway/*` API** — intercepted before any worktree resolution (works on
   every host): `GET /gateway/worktrees`, `POST /gateway/worktrees/<name>/restart`
   (what `./equin build` calls to deploy), `GET /gateway/worktrees/<name>/logs`
   (SSE stream of backend stdout/stderr: `history` frame with the ring buffer,
   then `entry` frames, `: ping` comment every 25s), `GET /gateway/services*`
   (supervisor state).
3. **Central-routes override**: path-prefix match against
   `~/.singularity/central-routes.json` (fsnotify-watched, atomically swapped).
   Wins on *any* host — this is how `/api/auth/callback/google` works on bare
   `http://localhost:9000` (Google requires bare-localhost redirect URIs).
   The manifest is written by `./equin build` from every plugin's
   `central/index.ts` route maps.
4. **`/zero`, `/zero/*`** → the worktree's zero-cache sidecar over loopback
   TCP, prefix stripped (zero-cache mounts its sync route at `/`). 404 if the
   pilot isn't enabled.
5. **`/api/*`, `/ws/*`** → the worktree backend over its Unix socket:
   - HTTP: `httputil.ReverseProxy` with an in-flight counter so hot restarts
     drain before killing the old process.
   - WebSocket: hand-rolled — dial the UDS, hijack the client TCP connection,
     write the raw HTTP upgrade request through, then two `io.Copy`
     goroutines shuttle bytes until either side closes. **A WS is pinned to
     the backend that was live at dial time** — hot restarts only affect new
     connections.
6. **Everything else** → static files from `web/dist`, with SPA fallback to
   `index.html` for extensionless paths.

### Why subdomains?

Each worktree is a complete, isolated app instance (own backend, own DB
fork, own deployed frontend). Subdomain = namespace gives free cookie/storage
isolation per agent worktree and lets the same `dist` bundle compute its API
base as "same origin".

## 3. Zero-downtime deploys (the build → restart handshake)

`./equin build` finishes by:

1. Writing the worktree spec (`~/.singularity/worktrees/<name>/spec.json`) —
   how to start the server, where the web dist lives, zero-cache options.
2. Writing `.build-id` into the staging dir, then **atomically renaming** the
   `dist` symlink (never a gap where assets are missing).
3. `POST /gateway/worktrees/<name>/restart`.

The gateway then boots the **new** backend on the *alternate* socket path
(`<name>.next.sock` alternates with `<name>.sock`), polls
`GET /api/health/ready` over the UDS until it returns 200 (which only happens
after the backend's `onReadyBlocking` barrier — migrations applied, pools
warm, registries built), atomically swaps the proxy pointer, drains the old
backend's in-flight HTTP, and kills it. Open WebSockets to the old process
keep working until they close; the client's reconnect logic (see
[04-live-state](./04-live-state.md)) re-subscribes against the new process.

Consequence worth knowing: the **dist swap happens before the backend
restart**, so for a short window the browser can be served new assets by a
backend that still reports the old build id — which is why
`getServerBuildId()` re-reads `.build-id` on every call instead of caching
(commit `2aefc8770`; details in [05-boot-and-hydration](./05-boot-and-hydration.md) §7).

## 4. Inside a backend: the Bun server (`framework/plugins/server-core/bin/index.ts`)

One Bun process per worktree, `Bun.serve({ unix: SOCKET_PATH, fetch, websocket })`.
No TCP. Boot sequence:

1. **Import** every plugin's `server/index.ts` from the generated registry
   (`Promise.allSettled` — a broken plugin is skipped and logged, not fatal).
2. **Register phase** (sequential, topo-sorted by `dependsOn`): runs every
   `Registration.register()` from plugins' `register: []` arrays — this is
   where `defineJob`, `defineTriggerEvent`, `Mcp.tool`, resource declarations
   land in global registries. A throw here aborts boot (a half-built registry
   must never serve).
3. **Route population**: all plugins' `httpRoutes`/`wsRoutes` flatten into a
   literal map (`"METHOD /path"` → handler, O(1)) plus a linear-scan list for
   `:param` routes. server-core itself injects `wsRoutes["/ws/notifications"]`
   and `GET /api/resources/:key`.
4. **Socket bind** — from here requests are accepted (but readiness is still
   false). Every handler runs through `safeHandle`: catch → log →
   `reportServerError` → generic 500. A throwing handler never kills the
   process.
5. **`onReadyBlocking` phase** — graph-driven barrier (each plugin's hook
   awaits its dependencies' hooks): DB readiness, pool warmup, migrations,
   derived tables/views rebuild, change-feed trigger rebuild. When all
   resolve → `markServerReady()` → `/api/health/ready` starts returning 200
   → the gateway hot-swaps. A `loadBearing` plugin's failure aborts boot;
   others are logged and skipped.
6. **`onReady`** — background work (watchers, LISTEN, graphile-worker start,
   L2 catch-up). **`onAllReady`** — a final barrier for plugins that need to
   observe others' onReady state.
7. **Shutdown**: SIGTERM runs every `onShutdown()` in parallel; a ppid poll
   self-exits if the gateway dies (macOS has no `PR_SET_PDEATHSIG`).

`ServerPluginDefinition` is a flat data object — routes + resources +
registrations + 4 lifecycle hooks. No base classes, no middleware stack;
shared concerns are plugins (profiler wraps the chokepoints, endpoints wraps
handlers).

## 5. The central runtime

A second Bun process (built by `framework/central-core`, plugin registry
`central.generated.ts`) hosting per-user state shared by all worktrees:

- **auth** (`plugins/auth/central/`): OAuth flows, token store, refresh loop,
  `authStateResource`.
- **secrets** (`plugins/infra/plugins/secrets/`): AES-256-GCM encrypted blob
  at `~/.singularity/secrets.json.enc`, master key in the OS keychain
  (fallback `~/.singularity/secrets/.key`).

It runs the **same resource runtime** as worktree backends but exposes it at
`/ws/central-notifications`; client descriptors created with
`centralResourceDescriptor()` are tagged `origin: "central"` and the
`NotificationsClient` maintains a second, independent socket channel for
them. Worktree backends that need a token call central over the gateway
(`getTokenFromCentral()` from `@plugins/auth/server`); central plugins call
each other in-process.

Rationale: connecting Google once should light up Gmail in every worktree.
Tokens and secrets are per-user, so they can't live in per-worktree DB forks.

## 6. Ports & paths quick reference

| Thing | Value |
|---|---|
| Browser traffic | `http://<worktree>.localhost:9000` (main app: `equin.localhost:9000`) |
| Backend sockets | `~/.singularity/sockets/<name>.sock` (+ `.next.sock` during hot swap) |
| Postgres | `127.0.0.1:5433` (`SINGULARITY_PG_PORT` override), user `singularity`, `wal_level=logical` |
| PgBouncer | `:6432`, transaction mode, catch-all `* =` routing (new DBs need no reconfigure) |
| zero-cache | `:4848` + per-worktree ports, gateway-proxied under `/zero` |
| Worktree specs | `~/.singularity/worktrees/<name>/spec.json` |
| Central routes | `~/.singularity/central-routes.json` |
| Logs | `~/.singularity/worktrees/<name>/logs/<channel>.jsonl` |
| Secrets | `~/.singularity/secrets.json.enc` |
| Attachments | `~/.singularity/attachments/` (UUID-named) |
