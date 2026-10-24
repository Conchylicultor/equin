# Local release preview: per-instance Postgres port + robust teardown

**Date:** 2026-06-24
**Category:** release
**Status:** Plan — awaiting approval

## Context

The Studio Release pane can build a composition release artifact and start/stop an
in-app local preview (the Preview/Stop endpoints, the `release.previews` live
resource, and the clickable URL all work), but the previewed app never comes up on
the same host as the running dev environment.

**Root cause.** The embedded Postgres port is the hardcoded constant
`PG_PORT = 5433` (`plugins/database/plugins/embedded/shared/internal/paths.ts:4`).
A release boots PG with `listen_addresses=127.0.0.1` (added for Zero logical
replication), so PG binds a **loopback TCP listener on 127.0.0.1:5433** in addition
to its Unix socket. The dev gateway-owned cluster already owns `127.0.0.1:5433`, so
the preview's PG fails to bind, never creates its socket, and the launcher's
`awaitPgReady` (30s) times out — the launch crashes, leaving an orphan gateway
returning 404. A release is designed for a fresh host where 5433 is free; previewing
locally next to the dev stack collides.

**Key finding (narrows the fix).** Only PG's TCP listener collides. Everything else
in a preview already roots under a unique data dir (`/tmp/sgp-XXXXXX` via
`SINGULARITY_DIR`), so all Unix sockets are collision-free by construction:
- PG's Unix socket: `<dataRoot>/postgres/socket/.s.PGSQL.<port>` — unique dir.
- **PgBouncer binds only a Unix socket** (`listen_addr =` empty, no TCP) at
  `<dataRoot>/postgres/socket/.s.PGSQL.6432` — unique dir, never collides.

So the per-instance variable is **one PG TCP port**. PgBouncer's listen port stays
6432; only its *upstream reference* to PG must honor the override.

**Second issue — teardown leaks daemons.** The preview's process tree is fully
detached after boot: the `launch` process exits once boot completes; the gateway is
`unref()`'d into its own session; `pg_ctl` forks+setsid and `pgbouncer -d`
daemonize. The gateway is *by design* not the owner of PG/PgBouncer
(`gateway/supervisor.go` `StopAll` only stops watchdogs — "Services themselves are
daemons and keep running"). Today `stopPreview`:
- `process.kill(-entry.pid)` targets the **launch** process group — but launch is
  already dead post-boot, so this no-ops.
- `killListenerOnPort(port)` SIGTERMs the **gateway** (whose graceful shutdown does
  kill the backend) — but **PG and PgBouncer are left running**, orphaned, holding
  the PG TCP port, after their data dir is `rm`'d out from under them.
- reconcile uses `isPidAlive(entry.pid)` on the **launch** pid (ephemeral) instead
  of the long-lived gateway — and the previews map is in-memory, so a dev backend
  restart orphans every running preview stack with no record.

**Intended outcome.** A release artifact is previewable on the same machine as the
dev environment, and stopping (or a dev restart) leaves no orphan clusters/ports.

Design doc this builds on: `research/2026-06-22-global-release-lifecycle-studio-ui.md`.

## Decisions (confirmed with user)

1. **PgBouncer listen port kept fixed at 6432.** Only `SINGULARITY_PG_PORT` is
   introduced. PgBouncer's upstream `[databases] port=` honors it; its own listen
   port doesn't vary (Unix-socket-only ⇒ collision-free). No `SINGULARITY_PGBOUNCER_PORT`.
2. **Full robust teardown.** Ordered pidfile-based teardown owned by the launcher,
   gateway-tracked liveness, and a boot-time sweep of orphaned `/tmp/sgp-*` stacks.

## Plan

### 1. Make the PG port per-instance via `SINGULARITY_PG_PORT`

The single source of truth is the `PG_PORT` constant — every PG consumer
(`embedded/scripts/start.ts`, `launcher/boot.ts`) imports it, so making the constant
env-derived threads the override everywhere automatically.

- **`plugins/database/plugins/embedded/shared/internal/paths.ts`**
  ```ts
  export const PG_PORT = process.env.SINGULARITY_PG_PORT
    ? Number(process.env.SINGULARITY_PG_PORT)
    : 5433;
  ```
  Dev (env unset) → 5433, zero behavior change. Validate it's a positive integer;
  throw loudly otherwise.

- **`plugins/database/plugins/pgbouncer/scripts/start.ts:17`** — the duplicated
  literal `const PG_PORT = 5433` (the *upstream* port PgBouncer dials; standalone
  scripts can't use `@plugins` aliases) must read the same env:
  ```ts
  const PG_PORT = process.env.SINGULARITY_PG_PORT
    ? Number(process.env.SINGULARITY_PG_PORT)
    : 5433;
  ```
  `PGBOUNCER_PORT` (listen) stays from `../shared`, unchanged.

- **No change needed** in `embedded/scripts/start.ts` (uses the `PG_PORT` constant
  for `pg_ctl -o -p`, socket path, and `PGPORT` env — all inherit the override) or
  in `launcher/boot.ts`'s `database.json` writers (`connection.port` + `ready.unix`
  derive from the now-env-aware constant; `launch.ts` sets env before importing boot).

**Env threading (already proven by `SINGULARITY_PG_BIN_DIR`).** The preview manager
sets `SINGULARITY_PG_PORT` in the `launch` spawn env. `launch.ts` dynamic-imports
boot *after* env is in place (constant freezes to the override). `spawnGatewayDaemon`
spreads `{ ...process.env }` to the gateway; the gateway forwards `os.Environ()` to
the supervised `pg-start`/`pgbouncer-start` scripts and to the backend — so PG binds
`127.0.0.1:<override>`, PgBouncer dials `<override>` upstream, and the backend reads
ports from `database.json` (already config-driven). `launch.ts` itself needs **no
change** — the var flows transparently; for a real release it's unset → 5433.

### 2. Preview manager: pick a free PG TCP port

`plugins/release/server/internal/preview-manager.ts`

- Add a PG port floor (e.g. `PREVIEW_PG_PORT_FLOOR = 5500`, skip dev's 5433) and pick
  with the existing `pickFreePort()` — its TCP-connect probe is exactly right since
  PG TCP-binds the loopback port.
- In `startPreview`, after picking the HTTP `port`, pick `pgPort` and pass it:
  ```ts
  env: { ...process.env, SINGULARITY_DIR: dataRoot, PORT: String(port),
         SINGULARITY_PG_PORT: String(pgPort) },
  ```
- Store `pgPort` in `PreviewEntry` (`preview-state-resource.ts`) so teardown can
  backstop-kill it. (Internal field, not projected into the public `Preview`.)

### 3. Robust, ordered teardown owned by the launcher

The launcher owns boot of the self-contained stack; make it own teardown too
(symmetric). It already imports every needed constant.

- **Root-parameterized pidfile builders** (so paths can be rooted at an arbitrary
  preview `dataRoot`, not the dev `SINGULARITY_DIR`):
  - `embedded/shared`: `export const pgPostmasterPidFile = (root: string) =>
    join(root, "postgres", \`data-pg${PG_MAJOR}\`, "postmaster.pid");`
    Re-express `PG_PID_FILE` via it; re-export from `embedded/server`.
  - `pgbouncer/shared`: `export const pgbouncerPidFileUnder = (root: string) =>
    join(root, "postgres", "pgbouncer.pid");` re-express `PGBOUNCER_PID_FILE`;
    re-export from `pgbouncer/server`.
  - `launcher/boot.ts`: `export const gatewayPidFile = (root: string) =>
    join(root, "gateway.pid");` (re-express `PID_FILE`).

- **`teardownSelfContainedApp({ root, httpPort, pgPort }, log?)`** in `launcher/boot.ts`,
  exported from the launcher server barrel. Ordering is **watchdog-safe**:
  1. **Gateway first.** Read `gatewayPidFile(root)`, SIGTERM, poll `isRunning` to a
     short deadline (~10s). This stops the supervisor watchdog (which would otherwise
     restart PG/PgBouncer on their 2s probe) *and* triggers the gateway's graceful
     shutdown, which SIGTERM→SIGKILLs the backend. Backstop: `killListenerOnPort(httpPort)`.
  2. **PgBouncer.** Read `pgbouncerPidFileUnder(root)`, SIGTERM.
  3. **Postgres.** Read `pgPostmasterPidFile(root)` (PID = first line), **SIGQUIT**
     (immediate shutdown — data dir is discarded, so no graceful drain needed).
     Backstop: `killListenerOnPort(pgPort)` (PG TCP-binds the override port).
  - Missing pidfile / `ESRCH` are expected no-ops. Move `killListenerOnPort` into the
    launcher (or keep a small copy) so teardown is self-contained.

- **`stopPreview`** replaces the `process.kill(-pid)` + `killListenerOnPort` block
  with one `teardownSelfContainedApp({ root: entry.dataRoot, httpPort: entry.port,
  pgPort: entry.pgPort })`, then `rmSync(dataRoot)`.

### 4. Liveness + cross-restart orphan sweep

`plugins/release/server/internal/preview-manager.ts`

- **Liveness by gateway, not launch pid.** A preview is alive iff its gateway is
  alive: `isRunning(readPid(gatewayPidFile(entry.dataRoot)))`. (Tolerate the brief
  startup window before `gateway.pid` exists — treat "no pidfile yet" as alive.)
- **`reconcileOrphanPreviews` (boot)** additionally sweeps the filesystem: for every
  `/tmp/sgp-*` dir **not** in the active map, run `teardownSelfContainedApp` for that
  root + `rmSync`. On a fresh boot the in-memory map is empty, so this reaps every
  orphaned stack a prior dev backend left running (the real cross-restart robustness
  win). Use a bounded glob, not `find`.

### 5. Deadline for cold initdb under contention

`launcher/boot.ts`: bump `PG_READY_TIMEOUT_MS` 30_000 → **90_000**. A preview's PG is
a from-scratch `initdb` running *alongside* the full dev stack (CPU/IO contention),
so 30s is too tight. This launcher constant is release/preview-only (distinct from
the database plugin's own `awaitPgReady`), so dev boot is unaffected. The pg-start
script's `pg_ctl -w -t 30` is post-initdb readiness and stays.

## Out of scope / follow-ups

- **Zero in previews.** `cache-service/shared/internal/paths.ts:16` hardcodes
  `postgresql://singularity@127.0.0.1:5433/...`. Zero-cache is opt-in and **not**
  included in release previews (`writeReleaseDatabaseConfig` omits it), so it's
  unaffected. If preview-with-Zero is ever wanted, that DSN must honor the override
  too. Note, don't fix now.
- **Durable preview tracking.** Previews remain in-memory; the boot `/tmp/sgp-*`
  sweep handles cross-restart orphans without a DB table. A durable previews table
  (like `release_runs`) is a larger, separate change.

## Files to modify

| File | Change |
|---|---|
| `plugins/database/plugins/embedded/shared/internal/paths.ts` | `PG_PORT` env-derived; add `pgPostmasterPidFile(root)`; re-express `PG_PID_FILE` |
| `plugins/database/plugins/embedded/server/index.ts` | re-export `pgPostmasterPidFile` |
| `plugins/database/plugins/pgbouncer/scripts/start.ts` | duplicated upstream `PG_PORT` reads `SINGULARITY_PG_PORT` |
| `plugins/database/plugins/pgbouncer/shared/internal/paths.ts` | add `pgbouncerPidFileUnder(root)`; re-express `PGBOUNCER_PID_FILE` |
| `plugins/database/plugins/pgbouncer/server/index.ts` | re-export `pgbouncerPidFileUnder` |
| `plugins/infra/plugins/launcher/server/internal/boot.ts` | `gatewayPidFile(root)`; `teardownSelfContainedApp`; `killListenerOnPort`; bump `PG_READY_TIMEOUT_MS`→90s |
| `plugins/infra/plugins/launcher/server/index.ts` | re-export `teardownSelfContainedApp`, `gatewayPidFile` |
| `plugins/release/server/internal/preview-state-resource.ts` | add `pgPort` to `PreviewEntry` |
| `plugins/release/server/internal/preview-manager.ts` | pick free PG port + pass env; `stopPreview` → launcher teardown; gateway-pid liveness; `/tmp/sgp-*` boot sweep |

## Verification

1. `./equin build` in the worktree (regenerates migrations, rebuilds, restarts,
   registers gateway). Confirm clean boot — dev cluster unaffected (`SINGULARITY_PG_PORT`
   unset ⇒ 5433).
2. In Studio → Release: run a release for a small composition, wait for `succeeded`.
3. Click **Preview**. Confirm via release logs the launcher reports PG binding the
   chosen override port and `App "<comp>" is serving`; the clickable URL
   (`http://<comp>.localhost:<httpPort>`) opens the previewed app **while dev is
   running**. Use `e2e/screenshot.mjs` to click Preview and capture before/after.
4. Confirm isolation with the `query_db` MCP tool / `lsof`: a second PG is listening
   on `127.0.0.1:<override>` and the dev 5433 is untouched.
5. Click **Stop**. Verify (`lsof -ti tcp:<override>`, `lsof -ti tcp:<httpPort>`, and
   `pgrep -f pgbouncer`/`postgres` against the tmp dir) that gateway, backend, PG,
   **and** PgBouncer are all gone and `/tmp/sgp-XXXXXX` is removed. The override port
   is free for re-preview.
6. Cross-restart sweep: start a preview, then `./equin build` (restarts the dev
   backend). Confirm the boot sweep tears down the orphaned stack (no listener on the
   override port, `/tmp/sgp-*` cleaned).
7. Cold-deadline: confirm a from-scratch preview boots within 90s even under load.
