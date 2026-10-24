# F3 — Self-contained launcher: boot an app's full runtime on a clean machine

> Status: implementation plan. Sub-task **F3** of the self-contained app release vision
> ([`2026-06-19-global-self-contained-app-release.md`](./2026-06-19-global-self-contained-app-release.md)).
> Category: `global` (touches `infra/paths`, `database`, `gateway`, `cli`).
> Depends on F1 (filtered bundle) + F2 (static spec). **F3 is independently testable against the full tree** — it serves whatever `server`/`web` the spec points at; F1's filtered bundle just swaps which dist/registry is served.

## Context

Today there is no single entry point that boots a packaged app's runtime end to end. Serving an app requires a prior `./equin build` **and** `./equin start`, and DB provisioning forks the `singularity` DB (git/conversation-coupled). A self-contained release needs a launcher that, on a machine with **no worktree and no prior build**, brings up embedded Postgres + PgBouncer + the gateway, registers a static app spec, ensures the app DB exists via **create-empty-then-migrate** (the boot migrator already applies the schema), and serves the app — using a **release-specific data root, ports, and socket dir** so a packaged install never collides with a developer's dev install on the same machine.

`start.ts` already supplies ~80% of this (embedded PG/PgBouncer supervision via the gateway, daemonize). Its only gap is that it assumes a prior `./equin build` produced the spec + dist, and it always roots at the dev `~/.singularity`.

## Key facts that shaped this design (all verified)

- **The gateway is the sole supervisor of the PG cluster.** It reads `~/.singularity/database.json`, parses `services[]`, and spawns each (`bun run .../embedded/scripts/start.ts`) via `gateway/supervisor.go` (`NewSupervisor` `main.go:105`, `StartAll` `main.go:132`). **Consequence: the app DB can only be created *after* the gateway is spawned and PG is up.**
- **The gateway forwards `os.Environ()` to every backend** (`gateway/worktree.go:582`), appending `SOCKET_PATH` + `SINGULARITY_WORKTREE`. So a `SINGULARITY_DIR` the gateway is launched with propagates to the app backend automatically.
- **One env var can re-root the entire TS install.** `SINGULARITY_DIR` (`plugins/infra/plugins/paths/core/internal/paths.ts:31`) is the root for PG socket dir, config dir, attachments, reports, the worktrees registry, etc. Today it has **no env override**. The **only** independent recomputation that bypasses it is the `database.json` path in `plugins/database/core/internal/config.ts:26`; the rest of the `paths/check` allowlist is display strings or `~/.local` bins (correctly unaffected).
- **Gateway data paths are already CLI flags** (`-log-dir`, `-registry-dir`, `-sockets-dir`, `-central-routes-file`, `-listen` default `:9000`). The **one** hardcoded path is `database.json` at `gateway/main.go:106`.
- **Migrations are unconditional and fork-agnostic on boot.** Database plugin `onReadyBlocking` (`plugins/database/server/index.ts:15`) → `awaitDbReady()` → `runMigrations(db)` (`runner.ts:46`: `CREATE TABLE IF NOT EXISTS` ledger, applies all unapplied `.sql`). **An empty DB bootstraps fully from migrations alone.**
- **There is no "create empty DB" helper** — only `forkDatabase`. `databaseExists(name)` exists (`admin/server/internal/databases.ts:18`). PG has no `CREATE DATABASE IF NOT EXISTS`; the `databaseExists` guard is the right idempotency mechanism.
- **`writeWorktreeSpec({name, server, web?})` is already extracted** (`plugins/infra/plugins/worktree/server/internal/spec.ts`, exported from the barrel; F2 done). Writes `~/.singularity/worktrees/<name>/spec.json`; the gateway fsnotify watcher picks it up within 100ms.
- **The admin pool throws at module-load if `SINGULARITY_WORKTREE` is unset** (`pool.ts` / `client.ts:8`) even though `getAdminPool()` only ever talks to the `postgres` system DB. This guard is over-broad and blocks any admin-only caller.
- **PG (5433) / PgBouncer (6432) ports stay as-is in the release.** PG is socket-only; the socket dir moves under the release root with `SINGULARITY_DIR`, so distinct socket files = no collision with a dev cluster. The port literals are inert (no TCP exposure).

## Design

### The single data-root knob

Make `SINGULARITY_DIR` an **env override**, respected identically by the TS `paths` plugin and the Go gateway. Launch the gateway with `SINGULARITY_DIR=<releaseRoot>` → the gateway isolates its own paths **and** forwards the var to the backend → the backend's DB/config/attachments all re-root. One knob isolates the entire install. PID file, logs, registry, sockets, and the PG cluster all sit under `<releaseRoot>` automatically.

### Launcher ordering (race-free)

The launcher is a **release entry point**, invoked with `SINGULARITY_DIR` already set in its environment (all path constants are import-time frozen, so it cannot be set mid-process). It **fails loudly if `SINGULARITY_DIR` is unset** — never pollute the dev `~/.singularity`. Because `pool.ts` is made load-safe, the launcher does **not** need `SINGULARITY_WORKTREE`.

1. Locate-or-build the gateway binary (`go build -o gateway`).
2. `ensureDatabaseConfig(repoRoot)` → write the release `database.json` (embedded PG + PgBouncer services) under `<releaseRoot>`.
3. Spawn the gateway daemon (inherits `SINGULARITY_DIR`, add flag `-listen :<port>`). The gateway starts PG + PgBouncer.
4. Wait for PG ready: poll `getAdminPool().query("SELECT 1")` to a 30s deadline (mirrors `awaitDbReady`). The admin pool connects **direct to PG** (5433 socket), independent of PgBouncer.
5. `ensureDatabase("sonata")` — `CREATE DATABASE` if absent (in-process; works because the launcher's `SINGULARITY_DIR` makes `database.json`/socket resolution point at the release cluster).
6. `writeWorktreeSpec({ name: "sonata", server, web })` — **written last**, so the gateway only discovers the app *after* its DB exists. The gateway spawns the backend → `onReadyBlocking` → migrations apply on the empty DB → ready. (sonata is not eager-spawned; only `central` is, so spec-last is sufficient.)
7. Poll `http://sonata.localhost:<port>/api/health/ready` until 200.

## Implementation steps

### A. Data-root knob — TS
1. `plugins/infra/plugins/paths/core/internal/paths.ts:31` — `export const SINGULARITY_DIR = process.env.SINGULARITY_DIR ?? join(HOME_DIR, ".singularity")`. (Server barrel re-exports automatically; dev unchanged when the var is unset.)
2. `plugins/database/core/internal/config.ts:26` — import `SINGULARITY_DIR` from `@plugins/infra/plugins/paths/core` and derive `CONFIG_PATH` from it instead of recomputing `join(homedir(), ".singularity", ...)`. Then drop this file from the `paths/check` allowlist (`plugins/infra/plugins/paths/check/index.ts`) and confirm the grep no longer matches.

### B. Data-root knob — Go
3. `gateway/main.go` — derive `dataDir := os.Getenv("SINGULARITY_DIR")` (fallback `filepath.Join(home, ".singularity")`); root the flag **defaults** (lines ~44–51) **and** the hardcoded `dbConfigPath` (line ~106) on `dataDir`. Explicit `-listen`/`-registry-dir`/etc. flags still override.

### C. Admin-pool load-safety (chosen: make pool load-safe)
4. `plugins/database/plugins/admin/server/internal/pool.ts` (and/or `plugins/database/server/internal/client.ts`) — move the `SINGULARITY_WORKTREE` throw from module-load to **lazy**: only required when the worktree (non-admin) connection string is actually used. `getAdminPool()` (→ `postgres` DB) must import and run with no `SINGULARITY_WORKTREE`. This removes an over-broad guard at the source — every admin-only tool benefits.

### D. `ensureDatabase` helper
5. `plugins/database/plugins/admin/server/internal/databases.ts` — add `ensureDatabase(name)`: `assertSafeName(name); if (!(await databaseExists(name))) await getAdminPool().query(\`CREATE DATABASE "${name}"\`)`. Catch duplicate-database (PG `42P04`) defensively for the concurrent-launcher TOCTOU.
6. `plugins/database/plugins/admin/server/index.ts` — export `ensureDatabase`.

### E. Extract boot helpers into a plugin (chosen: plugin-first)
7. New plugin **`plugins/infra/plugins/launcher`** with a `server` barrel. Move out of `start.ts` (currently file-private), **parameterized by `port` and `repoRoot`/`bundleRoot`**:
   - `ensureDatabaseConfig(root)` (embedded-vs-system detection + `database.json` synthesis),
   - `pgbouncerService` / `pgbouncerConnection`,
   - gateway build/locate,
   - daemonize + pid-file write (`gw.unref()`),
   - `isGatewayListening(port)` and a `awaitPgReady()` admin-`SELECT 1` poll.
   Imports `writeWorktreeSpec` (worktree barrel), `ensureDatabase`/`getAdminPool` (admin barrel), `SINGULARITY_DIR` & friends (paths barrel). No cycles (DAG: launcher → database/worktree/paths).
8. `plugins/framework/plugins/cli/bin/commands/start.ts` — refactor to import the extracted helpers; thread the default port `9000` through the probes (replacing the hardcoded `:9000` strings). Behavior unchanged for dev `start`.

### F. The launcher command
9. New `plugins/framework/plugins/cli/bin/commands/serve-app.ts` (thin) — `./equin serve-app --name sonata --server <path> --web <path> --port <port>`:
   - Assert `process.env.SINGULARITY_DIR` is set; else exit with a loud error.
   - Run the ordering above (steps 1–7), all helpers from the launcher plugin.
   - Default `--server` = `plugins/framework/plugins/server-core`, `--web` = `plugins/framework/plugins/web-core/dist` for dev-testing against the full tree.
10. Register the command in the CLI program root.

## Out of scope (deferred to F4/F5)
- **Packaging / binary vendoring.** `ensureDatabaseConfig` detects embedded PG via `existsSync` on repo `node_modules` and writes `bun run <repoRoot>/.../start.ts` commands — repo-relative. Works for F3 dev-testing; F4 must swap `repoRoot`→`bundleRoot` and vendor the embedded PG/PgBouncer binaries at resolvable paths. The `repoRoot`/`bundleRoot` parameter (step 7) is the seam.
- **Bare-`localhost` / default-namespace routing.** F3 serves at `sonata.localhost:<port>` (subdomain routing, fine on macOS/Linux). Bare-localhost + Windows is an F5 concern (gateway default-namespace config).
- **Hot-swap upgrade choreography** (F4) and the ~15 TS files hardcoding `9000` (all in the auth/central/build/conversation closures — none in Sonata's bundle, none exercised by a running release; the served web is same-origin).

## Critical files
- `plugins/infra/plugins/paths/core/internal/paths.ts:31` — `SINGULARITY_DIR` env override
- `plugins/database/core/internal/config.ts:26` — route `database.json` path through `SINGULARITY_DIR`
- `gateway/main.go` (~44–51, ~106) — `dataDir` from env, root defaults + `dbConfigPath`
- `plugins/database/plugins/admin/server/internal/pool.ts` + `database/server/internal/client.ts:8` — lazy `SINGULARITY_WORKTREE` guard
- `plugins/database/plugins/admin/server/internal/databases.ts` + `.../server/index.ts` — `ensureDatabase`
- `plugins/infra/plugins/launcher/server` (new) — extracted boot helpers
- `plugins/framework/plugins/cli/bin/commands/start.ts` — refactor to import helpers, thread port
- `plugins/framework/plugins/cli/bin/commands/serve-app.ts` (new) — the launcher command
- `plugins/infra/plugins/worktree/server` (`writeWorktreeSpec`, reused) — spec writer

## Verification (end to end, dev machine)

```bash
# 1. Build the full web tree once (F3 serves it under a static spec).
./equin build

# 2. Boot a self-contained instance under an isolated data root + port.
SINGULARITY_DIR=$(mktemp -d /tmp/sonata-release.XXXX) \
  bun plugins/framework/plugins/cli/bin/index.ts serve-app \
  --name sonata --port 9100

# 3. Open the app.
open http://sonata.localhost:9100
```

Confirm:
- `<releaseRoot>/database.json`, `<releaseRoot>/postgres/socket/`, and `<releaseRoot>/worktrees/sonata/spec.json` all land under the temp dir; **the dev `~/.singularity` is untouched** (`git status` of the dev install + `ls ~/.singularity` unchanged).
- The `sonata` DB was created empty and migrated: `query_db` (or `psql`) against the release cluster shows `__singularity_migrations` populated.
- `http://sonata.localhost:9100/api/health/ready` returns 200; the app loads.
- Re-running the launcher is idempotent (DB already exists → no-op; spec rewritten).

Teardown: `kill $(cat <releaseRoot>/gateway.pid)`; PG is detached — stop it via its pidfile under `<releaseRoot>/postgres/data-pg18/postmaster.pid` (or `pg_ctl stop`).
