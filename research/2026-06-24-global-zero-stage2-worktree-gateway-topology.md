# Zero Stage 2 — make zero-cache work with the gateway / per-worktree DB model

> Stage 2 of [adopting Rocicorp Zero](./2026-06-23-global-adopt-zero-sync-engine.md).
> Builds on the Stage-1 `plugins/database/plugins/zero/` skeleton. This is the hard
> stage: it resolves the worktree-fork × zero-cache topology, wires provisioning
> into the worktree lifecycle, teardown into worktree reaping, and routes Zero's
> WS/HTTP through the existing per-subdomain gateway proxy.

## Context

We are replacing our hand-rolled `live-state` sync engine with Rocicorp Zero. Zero
binds **one `zero-cache` (replication slot + SQLite replica) per upstream Postgres
DB**. Our killer constraint is the **per-worktree DB-fork model**: each ephemeral
worktree gets its own forked Postgres DB (`<worktree-name>`), dozens of them, in one
shared gateway-owned embedded cluster (loopback TCP `127.0.0.1:5433`,
`wal_level=logical` already enabled). Stage 1 stood up a **single-DB, global**
zero-cache (one process against `singularity`, hardcoded port `4848`, replica at
`~/.singularity/zero/replica.db`, client pointed at `http://localhost:4848`).

The goal of this stage: **Zero works in any worktree exactly like live-state does
today** — same-origin, per-worktree, lazy, torn down with the worktree.

### Topology decision (locked)

The unit Zero binds to — one upstream DB — maps **1:1 onto a worktree fork**, so the
only viable topology is **one zero-cache per worktree fork**. (Shared-cache is
impossible: forks are separate *databases*, not schemas, and one zero-cache replicates
exactly one DB. Main-only defeats the stage goal.) The difficulty is therefore purely
**lifecycle + routing**, concentrated in three seams.

### Decisions confirmed with the user

1. **Lifecycle owner: the gateway worktree state machine.** zero-cache becomes a
   per-worktree sidecar spawned / idle-reaped / left-alone-across-hot-restart by the
   same machinery that owns the Bun backend. Reuses pid-sidecar orphan reaping, the
   idle sweep, and the subdomain proxy.
2. **Idle/teardown strategy: drop slot+replica on idle, re-COPY on resume.** No WAL
   accrual on idle forks, never blocks `DROP DATABASE`; resume pays a fresh initial
   COPY (seconds for a small fork).

### The one boundary rule that shapes the whole design

The gateway is **deliberately database-agnostic** — it reads only the `services`
array from `database.json` (`gateway/supervisor.go:60`), has no PG driver, no
connection constants. Dropping a replication slot is Postgres DDL. **Therefore the
gateway owns only the zero-cache *process* and *request routing*; all
slot/replica/Postgres state is TS-owned.** This keeps the gateway clean and puts the
DB work where the DB helpers already live (`@plugins/database/plugins/admin/server`).

## Two unknowns — RESOLVED (verified against `@rocicorp/zero@1.6.2`)

1. **Listen transport = TCP-only.** The zero-cache config exposes only `port`
   (default 4848); there is **no** `unix`/`socketPath` option, and
   `out/zero-cache/src/services/http-service.js:40` hardcodes
   `fastify.listen({ host: "::", port })`. So: the gateway **allocates a per-worktree
   loopback TCP port** (bind `:0`, record it in memory) and dials `127.0.0.1:<port>`.
   No `.zero.sock`, no `sun_path` length concern for zero-cache. (zero-cache binds all
   interfaces — minor LAN-exposure note for a single-user dev box, matching Stage-1's
   posture; restricting the bind host would require patching zero-cache. Follow-up, not
   a blocker.)
2. **Base path = strip `/zero` in the gateway.** zero-cache mounts routes at root
   (`/`, `/keepalive`, sync via `#init`) with no base-path config. The gateway
   **rewrites `/zero/...` → `/...`** before forwarding (HTTP + WS). Client `server` URL
   = absolute same-origin `${location.origin}/zero`.

   > Still open from Stage 1 (verify during integration, not a topology blocker): the
   > client never pushed `changeDesiredQueries` in 1.6.2. Confirm the real provider
   > integration syncs a query before relying on end-to-end liveness in step 3.

## Process model refinement (consequence of TCP-only + gateway ownership)

Stage-1 `start.ts` **daemonizes and exits 0** (the global-supervisor model, where
`gateway/supervisor.go` execs the start command synchronously then probes). The
per-worktree owner is instead the **worktree state machine** (`startBackend`), which
`cmd.Start()`s a long-lived process, tracks it, and pgroup-kills it on `Stop`.
Therefore `start.ts` is rewritten as a **foreground supervisor**: do the pre-flight
slot/replica cleanup, spawn the Node zero-cache **in the foreground** (not detached),
and `await child.exited` — so the gateway-tracked `bun run start.ts` pid owns the node
child via its process group, exactly like `bun bin/index.ts`. The global
`zeroCacheService` in `database.json` is retired (see Rollout).

## Seam 1 — Per-worktree provisioning (gateway state machine + spec)

**Keep the gateway DB-agnostic by carrying the upstream DSN in the worktree spec.**
The server side (which *does* know `PG_PORT`/`PG_USER`) composes the zero-cache start
command + upstream DSN and writes it into `spec.json`; the gateway just execs it.

- **spec.json gains an optional block** (only present when opted-in, see Rollout):
  ```jsonc
  "zeroCache": {
    "command": ["bun", "run", "<abs>/plugins/database/plugins/zero/plugins/cache-service/scripts/start.ts"],
    "upstreamDb": "postgresql://singularity@127.0.0.1:5433/<worktree-name>"
  }
  ```
  Composed in `writeWorktreeSpec` (`@plugins/infra/plugins/worktree/server`), reusing
  `PG_PORT`/`PG_USER`/`PG_SOCKET_DIR` from `@plugins/database/plugins/embedded/server`
  and `buildConnectionString` (`plugins/database/core/internal/config.ts:58`). The
  worktree name = DB fork name = subdomain.
- **Gateway `Spec` struct** (`gateway/worktree.go`) gains `ZeroCache *ZeroCacheSpec`.
- **Lazy spawn**: add `Worktree.EnsureZeroCache(ctx)` mirroring `Worktree.Ensure` /
  `startBackend` (`gateway/worktree.go:575`). It:
  - `removeBackendArtifacts(zcSocketPath)`, `exec.Command(spec.ZeroCache.Command...)`
    with `Setpgid: true`, env `ZERO_UPSTREAM_DB` (from spec), `ZERO_REPLICA_FILE`
    (gateway-computed, per-worktree — see below), and the listen socket/port.
  - `writeBackendSidecar(zcSocketPath, w.Name, cmd)` so the boot reconcile can reap an
    orphaned zero-cache after a gateway crash.
  - `waitReady`-equivalent dialing the zero-cache socket (zero-cache has its own
    readiness; poll its socket/port).
  - Track an `active *zeroCache` (new struct paralleling `backend`, holding `cmd`,
    `exitCh`, `socketPath`, `proxy`).
- **Trigger**: the `/zero/*` proxy handler calls `EnsureZeroCache` (cold-starts on the
  client's first Zero WS/HTTP), exactly as `handleHTTP` calls `wt.Ensure`.
- **Path-length guard** (`gateway/worktree.go:187`): add a check that
  `filepath.Join(cfg.SocketsDir, name+".zero.sock")` fits in `maxSocketPath` (104).
- **Per-worktree replica path**: gateway-computed, e.g.
  `~/.singularity/worktrees/<name>/zero/replica.db` (under the existing per-worktree
  dir). Gateway passes it via `ZERO_REPLICA_FILE`; it does **not** read or drop it.

**`start.ts` pre-flight (the clean-slate guarantee).** Adapt
`plugins/database/plugins/zero/plugins/cache-service/scripts/start.ts` so that before
launching the Node zero-cache it (running under bun, with repo access) **drops any
pre-existing Zero replication slot + publications on the target DB and removes the
stale replica file**, via `openShortLivedClient(dbName)`
(`plugins/database/plugins/admin/server/internal/pool.ts:91`). This makes resume
deterministic = the chosen drop-and-recopy semantics, and makes the script idempotent
under the supervisor/watchdog re-exec. It also generalizes Stage-1's hardcoded
`ZERO_UPSTREAM_DB`/`ZERO_REPLICA_FILE`/`ZERO_PORT` to read from env (mostly already
the case).

## Seam 2 — Routing `/zero/*` through the per-subdomain proxy

Client and zero-cache become **same-origin** via the existing subdomain proxy — no
CORS, no hardcoded host.

- **Client** (`plugins/database/plugins/zero/plugins/client/web/zero-root.tsx`):
  replace `server={`http://localhost:${ZERO_CACHE_PORT}`}` with the relative
  same-origin `server="/zero"` (i.e. `${location.origin}/zero`). `ZERO_CACHE_PORT`
  stops being a client concern.
- **Gateway proxy** (`gateway/proxy.go:60`, in `ServeHTTP`): add a `/zero/` branch
  *before* the `isBackendPath` check:
  ```go
  if strings.HasPrefix(r.URL.Path, "/zero/") {
      if isWebSocketUpgrade(r) { p.handleZeroCacheWebSocket(w, r, wt) } else { p.handleZeroCacheHTTP(w, r, wt) }
      return
  }
  ```
  - `handleZeroCacheWebSocket` clones `handleWebSocket` (`gateway/proxy.go:124`) — UDS
    dial via `net.Dialer.DialContext(ctx, "unix", zc.socketPath)`, `http.Hijacker`,
    bidirectional `io.Copy` — but `wt.EnsureZeroCache` and dialing the zero-cache
    socket. **Strip the `/zero` prefix** from the forwarded request line (pending
    verification #2).
  - `handleZeroCacheHTTP` reuses an `httputil.ReverseProxy` over the zero-cache UDS
    (mirror `newReverseProxy` at `gateway/worktree.go:853`), prefix-stripped.
  - Both call `wt.TouchBackend()` (or a dedicated `TouchZeroCache`) so Zero traffic
    keeps the worktree alive.

## Seam 3 — Teardown (idle + worktree reap), all TS-owned

`DROP DATABASE ... WITH (FORCE)` (`plugins/database/plugins/admin/server/internal/databases.ts:27`)
terminates backends but **does not drop replication slots** — a leftover Zero slot
makes the drop fail (spike finding #6). The gateway can't do DDL, so:

- **Worktree reap** (`plugins/debug/plugins/worktree-cleanup/server/internal/reap.ts:39`):
  insert a new step **before** `dropDatabase(id)`:
  ```ts
  opts.onStep?.("database");
  await dropZeroReplicationArtifacts(id);   // NEW
  await dropDatabase(id);
  ```
  `dropZeroReplicationArtifacts(id)` (new helper, in the zero umbrella's server
  barrel) uses `openShortLivedClient(id)` to
  `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE database = $1 AND slot_name LIKE 'zero%'`
  then `DROP PUBLICATION IF EXISTS` for Zero's `_zero_*` publications, ignoring
  not-found. This covers all three reap callers (`reap.ts` is shared by the job,
  single-delete, and bulk-delete handlers). The fork-temp-sweep needs **no** change
  (zero-cache never attaches to `*__forking` temps).
- **Idle drop (realizing "drop on idle" without gateway DDL): a scheduled reconciler.**
  Add a main-runtime `defineJob` `database.zero-slot-sweep` (mirror
  `plugins/database/plugins/fork/server/internal/fork-temp-sweep.ts`, `cron: */5`)
  that drops any Zero logical slot **`active = false` for longer than a grace window**
  and removes its replica file. When the gateway idle-reaps a worktree it SIGTERMs the
  zero-cache → the slot flips `active=false` → the sweep reclaims it. An active
  zero-cache holds `active=true`, so live worktrees are never touched. This also
  self-heals crash-orphaned slots. (start.ts's pre-flight then gives a fresh COPY on
  the next resume.) The gateway's `Stop` (`gateway/worktree.go:461`) only needs to
  SIGTERM the zero-cache alongside the backend and `removeBackendArtifacts` its socket
  — no PG work.

**Hot restart**: the zero-cache is **left running** across a backend hot restart — it
listens on its own socket and its slot/replica are independent of the backend socket
swap (`Restart`, `gateway/worktree.go:357`). No change to the restart path.

## Rollout — stay opt-in through Stage 2

Keep the existing `SINGULARITY_ZERO_CACHE` opt-in (`zeroCacheEnabled()`,
`plugins/infra/plugins/launcher/server/internal/boot.ts:115`), but move the gate from
the **global** `database.json` service (Stage 1) to the **per-worktree spec**:
`writeWorktreeSpec` emits the `zeroCache` block only when enabled. With the env unset,
specs carry no `zeroCache`, the gateway never spawns it, `/zero/*` 404s, and nothing
changes for anyone — zero churn. The global single-DB zero-cache service in
`ensureDatabaseConfig` (`boot.ts:119-135`, `zeroCacheService`) is **removed/retired**
in favor of the per-worktree model (or left inert behind the same opt-in until the
per-worktree path is proven, then deleted).

## Critical files

| Concern | File |
| --- | --- |
| zero-cache start script (env-driven + pre-flight slot/replica cleanup) | `plugins/database/plugins/zero/plugins/cache-service/scripts/start.ts` |
| New `dropZeroReplicationArtifacts` + `database.zero-slot-sweep` job | `plugins/database/plugins/zero/plugins/cache-service/server/` (+ a new `slot-lifecycle` internal) |
| Client same-origin `server="/zero"` | `plugins/database/plugins/zero/plugins/client/web/zero-root.tsx` |
| Spec `zeroCache` block (DSN + command), opt-in gated | `@plugins/infra/plugins/worktree/server` (`writeWorktreeSpec`), `plugins/infra/plugins/launcher/server/internal/boot.ts` |
| Embedded PG constants for the DSN | `plugins/database/plugins/embedded/shared/internal/paths.ts` (`PG_PORT`, `PG_USER`) |
| Admin connection to a fork DB for DDL | `plugins/database/plugins/admin/server/internal/pool.ts` (`openShortLivedClient`) |
| Reap slot-drop insertion | `plugins/debug/plugins/worktree-cleanup/server/internal/reap.ts:39` |
| Gateway: spec field, `EnsureZeroCache`, `startZeroCache`, idle `Stop` hook, path guard | `gateway/worktree.go` |
| Gateway: `/zero/*` HTTP+WS routing (prefix-strip) | `gateway/proxy.go` |
| Gateway: per-worktree dirs/sockets | `gateway/main.go`, `gateway/registry.go` |

## Verification (end-to-end)

1. **Pre-flight unknowns**: after `bun install`, confirm zero-cache listen transport
   (UDS vs TCP) and base-path/prefix-strip behavior (verify items above). Lock the two
   localized design choices accordingly.
2. **Build + opt-in**: `SINGULARITY_ZERO_CACHE=1 ./equin build` in a worktree.
   Confirm the worktree `spec.json` carries the `zeroCache` block with the correct
   `upstreamDb` (= this worktree's fork DB), and `query_db` shows the fork DB exists.
3. **Cold start + liveness**: open `http://<worktree>.localhost:9000`, mount the
   Stage-1 `debug/zero-test` pane (or the pilot slice). Confirm via browser devtools
   the Zero WS connects to **`<worktree>.localhost:9000/zero`** (same-origin, not
   `localhost:4848`), and that `query_db` against the fork shows a `zero%` replication
   slot `active=true`. Add a task via the `add_task` MCP tool and confirm the pane
   updates live with **no** `useResource`/live-state subscription behind it.
4. **Per-worktree isolation**: a second worktree gets its own slot + replica +
   zero-cache process against its own fork; the two do not interfere.
5. **Idle drop**: leave a worktree idle past the gateway idle timeout (10 min) → the
   backend + zero-cache are reaped; within the sweep grace window the `zero%` slot is
   dropped (`query_db`: gone) and the replica file removed. Re-open the app → zero-cache
   cold-starts, a fresh slot + COPY appears, the pane is live again.
6. **Teardown (closes #6)**: reap the worktree via Debug → Worktree Cleanup. Confirm
   the reap drops the Zero slot + publications **before** `DROP DATABASE`, and the fork
   DB is actually dropped (no "slot retains WAL / cannot drop database" failure).
7. **Opt-out unchanged**: with `SINGULARITY_ZERO_CACHE` unset, specs carry no
   `zeroCache`, `/zero/*` 404s, no zero-cache process exists, and existing live-state
   surfaces are byte-for-byte unaffected.
8. `./equin check` + `type-check` pass.

## Out of scope (later stages)

- Migrating real `defineResource`/`useResource` call sites and write endpoints to Zero
  (Stage 3/4) — this stage only makes the *infrastructure* work per-worktree.
- The `rank_text` unsupported-type gap (spike #1) — a Stage-3 schema concern; it does
  not block the topology, but no ordered list can migrate until it's resolved.
- zero-cache production hardening / `--admin-password` (still dev-mode); auth/JWT
  bridge and the mutator/permission model (Stage 1/3).
