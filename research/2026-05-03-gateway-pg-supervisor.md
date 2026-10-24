# Move embedded Postgres ownership from central (TS) to gateway (Go)

## Context

Today the embedded Postgres cluster is supervised by `plugins/infra/plugins/database/central/internal/supervisor.ts`, a load-bearing TS plugin that runs in the central runtime. Central spawns PG via `pg_ctl start` (which daemonizes it), arms a `setInterval` watchdog, and exposes `GET /api/database/status`. PG itself is detached so it survives central restarts on every `./equin build`.

This is a category mismatch. Central exists to host plugin TS code; PG is a host-level singleton, the same tier as the gateway itself. Having central supervise a process that intentionally outlives every central instance is awkward — bootstrap order is "central boots, also boots PG, also detaches it."

**Goal**: gateway (Go) becomes the sole PG supervisor. Bootstrap inverts cleanly: gateway → PG → central/backends. The legacy migrate-from-system-PG path (one-time tool from the embedded-PG transition) is dropped wholesale, simplifying the supervisor surface.

## End-state architecture

- `gateway/postgres.go` (new): `PgSupervisor` struct owning `initdb`, `pg_ctl start`, watchdog, and the JSON status response.
- Bootstrap: gateway HTTP server binds first, then `pgSup.Start(ctx)` blocks until PG is ready, then `wt.Ensure(ctx)` for central is kicked off in a goroutine.
- `/api/database/status` is intercepted in `proxy.go ServeHTTP` before the central-routes lookup. Response shape simplifies to `{ pg: "running"|"stopped"|"crashed", useSystemPg: boolean }` (migration fields gone).
- Gateway resolves PG binaries from `<repoRoot>/plugins/infra/plugins/database/node_modules/@embedded-postgres/<platform>/native/bin/` via a new `-repo-root` flag passed by `cli/src/commands/start.ts`.
- Database plugin's `central/` runtime is deleted entirely. The plugin keeps only its `server/` and `shared/` runtimes (constants consumed by worktree backends).
- `package.json` with `@embedded-postgres/*` optionalDependencies stays at `plugins/infra/plugins/database/package.json` so `bun install` still drops binaries in the right place.

## Files to add (Go)

**`gateway/postgres.go`**

```go
type PgState int
const (PgStateStopped PgState = iota; PgStateStarting; PgStateRunning; PgStateCrashed)

type PgSupervisor struct {
    repoRoot, pgDir, dataDir, socketDir, logFile, pidFile string
    port int; user string; maxConns int
    useSystem bool
    mu sync.Mutex
    state PgState
    watchStop chan struct{}
}

func NewPgSupervisor(repoRoot string) *PgSupervisor
func (s *PgSupervisor) Start(ctx context.Context) error    // blocking; runs initdb if needed, pg_ctl start -w, arms watchdog
func (s *PgSupervisor) Status() PgStatusResponse           // { Pg, UseSystemPg }
func (s *PgSupervisor) Stop()                              // clears watchdog only; PG daemon keeps running
```

Internal helpers: `resolveBinDir()`, `ensureSymlinks(binDir)`, `dataDirValid()`, `runInitdb(binDir)`, `startPg(binDir)`, `waitPgSocket(timeout)`, `runWatchdog(ctx)`, `attemptRespawn(binDir)`.

`resolveBinDir()` builds the path deterministically from `runtime.GOOS`/`runtime.GOARCH` (mapping to `darwin-arm64`/`darwin-x64`/`linux-x64`/`linux-arm64`) — no glob needed. Errors fast with `"embedded PG binaries not found at <path>; run bun install first"` if the directory is missing.

`ensureSymlinks` reads `<binDir>/../pg-symlinks.json` (array of `{source, target}`) and runs `os.Symlink(filepath.Base(source), absTarget)` for each missing target — basename-only target so the link resolves relative to its own directory. Idempotent.

Watchdog mirrors the TS approach: 2s `time.Ticker`, dial PG socket. On failure, unlink stale `postmaster.pid`, attempt one `pg_ctl start`, then mark crashed if that also fails. Don't auto-restart in a tight loop — same rationale as today (mask persistent failures).

Reattach behavior mirrors current supervisor: if `os.Stat(pidFile) == ok && net.Dial(socket) == ok`, skip spawn and just arm the watchdog. If pidfile exists but socket dead, unlink pidfile before `pg_ctl start`.

## Files to modify (Go)

**`gateway/main.go`**:
- Add `RepoRoot string` to `Config`; `flag.StringVar(&cfg.RepoRoot, "repo-root", "", "main repo root for PG binaries")`.
- Build `pgSup := NewPgSupervisor(cfg.RepoRoot)`.
- Reorder startup: `srv.ListenAndServe` goroutine → `pgSup.Start(ctx)` (blocking) → `go wt.Ensure(ctx)` for central.
- On shutdown: `pgSup.Stop()`.

**`gateway/proxy.go`**:
- Add `pg *PgSupervisor` field to `Proxy`; update `NewProxy` signature.
- In `ServeHTTP`, before the central-routes lookup:
  ```go
  if r.URL.Path == "/api/database/status" && r.Method == http.MethodGet {
      w.Header().Set("Content-Type", "application/json")
      _ = json.NewEncoder(w).Encode(p.pg.Status())
      return
  }
  ```

## Files to delete (TS)

- `plugins/infra/plugins/database/central/` — entire directory: `index.ts`, `internal/supervisor.ts`, `internal/handlers.ts`, `internal/initdb.ts`, `internal/migrate-from-system.ts`, `internal/paths.ts`, `internal/binaries.ts`.
- `plugins/infra/plugins/database/shared/internal/binaries.ts` — `pgBin()` and `ensurePgSymlinks()` have no remaining TS consumers once `central/` is gone.

## Files to modify (TS)

**`plugins/infra/plugins/database/shared/internal/paths.ts`**: drop `PG_MIGRATING_SENTINEL` and `PG_MIGRATION_DONE_MARKER`. Keep all other constants.

**`plugins/infra/plugins/database/shared/index.ts`**: prune `ensurePgSymlinks`, `pgBin`, `PgBinName`, sentinel constants from re-exports.

**`cli/src/paths.ts`**: drop `PG_MIGRATING_SENTINEL` export.

**`cli/src/commands/build.ts`**:
- Remove imports of `PG_MIGRATING_SENTINEL`, `PG_DATA_DIR`, `PG_LOG_FILE`.
- Replace `ensureDatabaseReachable()` (lines 243-305, ~30-minute deadline, migration-progress polling) with a tight `waitForPg()`:
  ```ts
  async function waitForPg(): Promise<void> {
    if (process.env.SINGULARITY_USE_SYSTEM_PG === "1") return;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch("http://localhost:9000/api/database/status");
        if (resp.ok && (await resp.json()).pg === "running") return;
      } catch {}
      await Bun.sleep(500);
    }
    console.error("ERROR: embedded Postgres not ready after 60s");
    process.exit(1);
  }
  ```
- Simplify `probeCentralHealth()` (lines 373-401): drop the `body.migration !== "running"` check; just check `resp.ok`. Rename to `probeCentralReady()`.
- Remove the early `central/restart` poke that was inside `ensureDatabaseReachable` — moot now that central no longer owns PG.

**`cli/src/commands/start.ts`**: pass `-repo-root` when spawning gateway:
```ts
const gw = Bun.spawn([gatewayBin, "-log-level", opts.logLevel, "-repo-root", repoRoot], ...);
```
`repoRoot` is already computed via `getMainRepoRoot()`.

**`plugins/infra/plugins/database/CLAUDE.md`**: drop the migration section, rewrite topology + lifecycle to describe gateway ownership. Autogen block regenerates on `./equin build`.

**`gateway/CLAUDE.md`**: add a section on PG supervision (mirror the structure of the existing worktree supervision section).

**`central/src/plugins.generated.ts`**: regenerated automatically by `generatePluginRegistry` once `database/central/index.ts` is gone — `infraDatabasePlugin` import and array entry disappear.

## Implementation sequence

The trick is the staged transition: the gateway must be rebuilt and restarted (via `./equin start`, a manual step) before central's PG supervisor can be safely deleted. Each commit must leave the system buildable.

1. **Add `-repo-root` flag (Go, additive, no behavior change).** Field in `Config`, `flag.StringVar`. Flag accepted but unused.
2. **Add `gateway/postgres.go` (Go, additive, not yet wired).** Full `PgSupervisor` implementation. Compiles but isn't called.
3. **Wire `PgSupervisor` into `main.go` and `proxy.go`.** Gateway now owns `/api/database/status` and starts PG before central. Briefly there are two PG owners: gateway and central. Safe because (a) `pg_ctl` is idempotent — second start sees the running cluster and returns success; (b) the reattach check (pidfile + socket dial) means neither side double-spawns; (c) two parallel watchdogs on the same socket is harmless. **Manual step at end of this commit: user runs `./equin start` to rebuild and restart the gateway.**
4. **Delete `database/central/` runtime; prune `shared/`.** Run `./equin build` to regenerate `central/src/plugins.generated.ts` and CLAUDE.md autogen blocks. After this commit, central no longer touches PG.
5. **Update `cli/src/commands/build.ts` (waitForPg, simplify probeCentralReady) and `cli/src/paths.ts`.**
6. **Update CLAUDE.md docs** (`database/CLAUDE.md`, `gateway/CLAUDE.md`).

After commits 1-3 land but before the user runs `./equin start`, central remains the sole PG owner — the new gateway code is on disk but not running. This window is fine. After the user runs `./equin start`, gateway and central both supervise PG until commit 4 lands and central's supervisor is deleted.

## Critical files to reference during implementation

- `gateway/main.go` (startup wiring, flag parsing, eager-spawn pattern at lines 117-123)
- `gateway/proxy.go` (route dispatch, `central-routes` lookup, `/gateway/*` API)
- `gateway/worktree.go:358-394` (`startBackend` — pattern for spawning a managed process), `423-438` (`waitReady` — pattern for socket polling)
- `plugins/infra/plugins/database/central/internal/supervisor.ts` (TS reference for porting initdb/pg_ctl/watchdog/reattach logic)
- `plugins/infra/plugins/database/shared/internal/binaries.ts` (TS reference for `platformPackage()`, `ensurePgSymlinks()` — port verbatim to Go)
- `plugins/infra/plugins/database/shared/internal/paths.ts` (canonical PG paths — must match gateway's hardcoded paths exactly)
- `cli/src/commands/build.ts:243-401` (existing migration-aware polling that gets simplified)
- `cli/src/commands/start.ts` (where to add `-repo-root` flag wiring)

## Verification

End-to-end smoke test for each milestone:

- **After commit 3 + `./equin start`**: gateway logs should show "PG ready" before "central spawning". `curl http://localhost:9000/api/database/status` returns `{"pg":"running","useSystemPg":false}`. `./equin build` in a worktree completes. The worktree app loads at `http://<worktree>.localhost:9000`.
- **After commit 4**: `./equin build` regenerates `central/src/plugins.generated.ts` cleanly. Central process logs no longer mention PG. `ps` shows gateway → PG (orphan, ppid=1), central as a separate process. `kill central; wait; ./equin build` — central restarts without touching PG.
- **Crash recovery**: `pg_ctl stop -D ~/.singularity/postgres/data-pg18`. Within ~4s, gateway's watchdog should re-spawn PG. `/api/database/status` flips `running → stopped → running`. If the second start also fails, status flips to `crashed`.
- **System PG fallback**: `SINGULARITY_USE_SYSTEM_PG=1 ./equin start` (rebuilds gateway). Gateway skips PG supervision entirely; status returns `{"pg":"running","useSystemPg":true}`. Backends connect to `localhost:5432`.
- **Cold start**: `rm -rf ~/.singularity/postgres/data-pg18 && ./equin start`. Gateway runs `initdb` on first boot (~3-5s); status returns `{"pg":"stopped"}` during initdb, then `{"pg":"running"}`. Central spawn waits for PG ready before starting.
- **Existing checks**: `./equin check` passes (`migrations-in-sync`, `eslint`, `plugins-doc-in-sync`, `plugins-registry-in-sync`, `plugin-boundaries`).

## Edge cases surfaced during planning

1. **Concurrent `pg_ctl start` during transition window** — gateway and central both call `pg_ctl start` until commit 4. Safe because both implement reattach (pidfile + socket dial) before spawning, and `pg_ctl` itself is idempotent.
2. **Linux dylib symlinks** — `pg-symlinks.json` is uniform across platforms; Linux uses `.so.N` versioned symlinks. `os.Symlink(filepath.Base(source), absTarget)` is platform-agnostic.
3. **`bun install` is still required** — Go resolves binaries from `node_modules/@embedded-postgres/<platform>/`. If `bun install` hasn't run, gateway errors clearly. `cli/src/commands/build.ts` already runs `bun install` as step 1.
4. **`SINGULARITY_USE_SYSTEM_PG=1` + missing `-repo-root`** — when `useSystem` is true, `resolveBinDir()` is never called. Empty default for `-repo-root` is harmless in that mode.
5. **Old gateway binary rejecting `-repo-root`** — old gateway will fatal with "flag provided but not defined". Self-healing: the new `start.ts` rebuilds the gateway before launching, so the new binary always understands the flag.
6. **Database plugin loses `loadBearing: true`** — accurate, since the supervision moves to a Go binary that's already load-bearing infra. Autogen reflects this.
