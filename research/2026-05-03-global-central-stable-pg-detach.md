# Stabilize `central` so it always runs main's code

## Context

`./equin build` writes `~/.singularity/worktrees/central.json` pointing at the *current worktree's* `central/` directory (`cli/src/commands/build.ts:452, 554`). Whichever worktree most recently built wins — the next time central cold-starts, it runs that worktree's plugin code, even after the worktree is deleted. Central is supposed to be a singleton serving every worktree from a single canonical source (main).

The "obvious" fix — point `central.json` at main and restart central on every build — is blocked by the fact that central currently bundles two unrelated lifecycles in one process:

- **Persistent infra**: the embedded Postgres cluster (spawned by the `database` plugin) and the secrets store.
- **Plugin route code**: thin shims around the persistent state (auth, db status, secrets API, …).

Restarting central today kills PG with it (`supervisor.ts:113` explicitly sets `detached: false` and `onShutdown` SIGINTs the proc), which would briefly break every worktree backend on every build. That's intolerable.

The honest framing: nothing in central's TS code is intrinsically unrestartable — the only thing we cannot lose is the **PG daemon and its on-disk state**. PG doesn't actually need to share a lifecycle with the code that talks to it. Detach PG so it outlives any central restart, and central becomes freely restartable. PG is then "system infrastructure" in the same way the gateway daemon is.

## Design

Three coordinated changes:

1. **Lock `central.json` to main's `central/`**, computed via `git rev-parse --git-common-dir`. Idempotent across worktrees.
2. **Detach embedded PG from central's process group** by switching from `Bun.spawn(postgres …)` to `pg_ctl start`. PG daemonizes, central no longer holds a process handle, central exit is a no-op for PG.
3. **Restart central on every `./equin build`** by POSTing `/gateway/worktrees/central/restart` after writing the spec, then probing `/api/database/status` for liveness.

After this, central restarts cost ~a second of central API downtime (PG keeps serving; only worktree → central calls blip), and every build picks up freshly-merged main code.

## Implementation

### 1. Lock `central.json` to main

**`cli/src/util/git.ts`** (new file)

Lift `getMainRepoRoot()` from `cli/src/commands/start.ts:38-46` (sole current caller at line 84) into a shared util. Both `build.ts` and `start.ts` import from there. Same implementation:

```ts
const proc = Bun.spawn(["git", "rev-parse", "--git-common-dir"], { stdout: "pipe" });
const raw = (await new Response(proc.stdout).text()).trim();
return dirname(resolve(raw));
```

**`cli/src/commands/build.ts`**

- Add `const mainRoot = await getMainRepoRoot();` near `const root = await getWorktreeRoot();` (line 415).
- Both `central.json` write sites (lines 448 and 551): change `const centralDir = resolve(root, "central")` to `const centralDir = resolve(mainRoot, "central")`. The `existsSync(join(centralDir, "src", "index.ts"))` check still works since main always has `central/src/index.ts` checked in.
- Keep type-checking the *worktree's* central at lines 498-502 — local edits should still be validated even though they don't run until merged. Introduce a separate `worktreeCentralDir = resolve(root, "central")` for that step. Add a one-line comment.
- Replace the misleading comment at lines 545-550 ("we always overwrite so the most recently built worktree's central runs") with one explaining the new invariant ("central.json always points at main; idempotent").

### 2. Detach embedded PG

**`plugins/infra/plugins/database/central/internal/supervisor.ts`**

Replace `Bun.spawn(postgres, …)` with `pg_ctl start`. `pg_ctl` daemonizes: it spawns PG, waits for it to be ready, and exits. PG continues running with no parent.

- **Drop `state.proc`** entirely from the `State` interface (line 30-38) and the module state (line 40-48). Also drop the `Subprocess` import.
- **Replace `spawnPostgres()` (lines 92-117)** with a `pg_ctl start` invocation:

  ```ts
  async function startPostgres(): Promise<void> {
    const proc = Bun.spawn(
      [
        pgBin("pg_ctl"),
        "start",
        "-D", PG_DATA_DIR,
        "-l", PG_LOG_FILE,
        "-o", `-k ${PG_SOCKET_DIR} -p ${PG_PORT} -c max_connections=${MAX_CONNECTIONS} -c listen_addresses=`,
        "-w",                          // wait for ready
        "-t", "30",                    // 30s timeout (matches existing waitReady)
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    if ((await proc.exited) !== 0) {
      throw new Error("pg_ctl start failed; see " + PG_LOG_FILE);
    }
  }
  ```

  `pg_ctl` is shipped by `@embedded-postgres/<platform>` alongside `postgres` and `initdb` — `pgBin("pg_ctl")` resolves the same way.
- **`onReady` (lines 140-217)**: add an early-return branch for "PG already running":

  ```ts
  if (existsSync(PG_PID_FILE) && (await pgIsReady())) {
    state.ready = true;
    startWatchdog();
    state.migration = "completed";  // any first-boot migration must already have completed
    resolveReady();
    return;
  }
  ```

  Place it after the migration-sentinel guard (line 151-157) and the `dataDirPartial`/`fresh`/stale-pidfile branches. The existing stale-pidfile cleanup at line 169-177 still applies for the case where `pidfile exists && !pgIsReady`.

  Then replace `state.proc = spawnPostgres(); await waitReady(30_000);` (lines 179-180) with `await startPostgres();` — `pg_ctl -w` already waits for ready. `waitReady` and `pgIsReady` keep their existing roles for the watchdog.
- **`onShutdown` (lines 219-250)**: collapse to just clearing the watchdog interval. Remove the SIGINT/SIGKILL logic entirely. PG keeps running; that's the whole point. Add a one-line comment: "PG is a long-lived daemon owned by no central instance; OS reaps on machine shutdown."
- **Watchdog `startWatchdog` (lines 119-138)**: the `await pgIsReady()` poll is already process-handle-agnostic. Replace the re-spawn body's `state.proc = spawnPostgres(); await waitReady(15_000);` with `await startPostgres();`. Drop the `state.proc =` assignment everywhere.
- **`status()` (lines 260-270)**: unchanged. Driven by `state.ready` and `state.crashed`, both still maintained.

### 3. Restart central on build

**`cli/src/commands/build.ts`**

After the late `central.json` write (line 554) — *before* the per-worktree `/restart` block at lines 564-582 — add a central restart and liveness probe:

```ts
if (existsSync(join(centralDir, "src", "index.ts"))) {
  console.log("Restarting central...");
  try {
    const resp = await fetch("http://localhost:9000/gateway/worktrees/central/restart", {
      method: "POST",
    });
    if (resp.ok) {
      await probeCentralHealth();
    } else if (resp.status !== 404) {
      console.warn(`Central restart returned ${resp.status}`);
    }
  } catch {
    // gateway not running — central will spawn fresh on first request
  }
}
```

Add `probeCentralHealth()` next to the existing `probeHealth()` (build.ts:348-370). Same shape — 10s deadline, 250ms poll — but hits `http://singularity.localhost:9000/api/database/status` (the gateway routes `/api/database/status` to central via the central-routes manifest regardless of subdomain). Refuse to consider central healthy if `migration === "running"` — restarting central mid-migration is a real footgun on the very first install.

The existing per-worktree restart at lines 564-582 stays as-is; running it after the central restart is fine (worktree backend respawn lazily reconnects to PG via the existing `awaitPgReady` retry in `server/src/db/client.ts:100-128`).

## Critical files

- `cli/src/commands/build.ts` — central.json now points at main; central restart + health probe added.
- `cli/src/commands/start.ts` — replace local `getMainRepoRoot` with import from new util.
- `cli/src/util/git.ts` — new file holding `getMainRepoRoot()`.
- `plugins/infra/plugins/database/central/internal/supervisor.ts` — switch to `pg_ctl`, drop `state.proc`, simplify `onShutdown`, add "already running" early return in `onReady`.
- `plugins/infra/plugins/database/CLAUDE.md` — update lifecycle section: PG now started via `pg_ctl`, survives central restarts, `onShutdown` no longer signals PG.

## Verification

End-to-end smoke once implemented:

1. `./equin build` from this worktree. Inspect `~/.singularity/worktrees/central.json` — `server` field must point at main's `central/`, not the worktree's.
2. `cat ~/.singularity/postgres/data-pg18/postmaster.pid` — note the PID. `ps -p <pid>` confirms PG is running.
3. `./equin build` from a *different* worktree. `central.json` content must be byte-identical. PG's PID must be unchanged (PG was not killed). Central's gateway-spawned process *was* restarted — verify by tailing gateway logs (`tail -f ~/.singularity/logs/gateway.log`) for "backend ready" on `central` after the build.
4. While the above runs, hit `curl http://singularity.localhost:9000/api/database/status` mid-build. Expect either a brief 502 during central restart or `{"pg":"running",…}`. Worktree pages (`http://singularity.localhost:9000`) must keep loading throughout.
5. `kill -9 <pg-pid>` to simulate a PG crash. Within ~2s the watchdog should re-spawn PG (via `pg_ctl start`) and `/api/database/status` should report `pg: "running"` again.
6. Restart the gateway (`./equin start --force`). PG's PID *must not change* — gateway restart should not touch PG.
7. Edit a file in main's `central/` (e.g. add a `console.log` to `database/central/index.ts`), commit on main, then `./equin build` from a worktree. New log line must appear in central's stdout (gateway logs) — proves new central code is loaded.

## Out of scope (deferred)

- **`./equin stop-database`** to fully shut down the PG daemon. Not needed for this fix; `pkill postgres` works as a manual reset; can be added later as a thin wrapper around `pg_ctl stop -D <data_dir> -m fast`.
- **`db-backup` plugin's env-var fallback to system PG** (`plugins/debug/plugins/db-backup/server/internal/handle-backup.ts`) — separate bug, file independently.
- **Lifting PG into its own gateway-supervised entity** (the rejected option from design discussion). Not needed once PG is detached; central restartability is the real goal, achieved without the extra plumbing.

## Edge cases

- **Migration in flight during a restart**: the fire-and-forget `migrateFromSystemPg` (supervisor.ts:194-208) is multi-minute on first install. If a restart fires while it's running, the new central refuses to boot via the `priorMigrationInProgress()` guard (line 151-157). The `probeCentralHealth` step will detect this and surface a clear error rather than silently leaving central down. User can wait for migration completion (visible at `/api/database/status`) and rebuild. This already-existing guard is what makes the restart safe.
- **First-build-on-fresh-clone**: main's `central/` is checked in, so `existsSync(join(centralDir, "src", "index.ts"))` always passes from main's tree. No bootstrap problem.
- **Concurrent worktree builds**: two builds calling `/restart central` is benign (two stop+respawn cycles, idempotent central.json content). Existing per-worktree `webDir/.build.lock` does not serialize across worktrees, but that's true today and we're not making it worse.
