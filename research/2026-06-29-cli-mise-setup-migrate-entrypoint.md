# Fix mise setup bootstrap: restore the migration entry point

## Context

`mise.toml`'s `[hooks] postinstall = "mise run setup"` bootstraps the base
`singularity` Postgres DB on a fresh clone. Its step 2 invokes:

```
SINGULARITY_WORKTREE=singularity bun server/src/db/migrate.ts
```

That file was **deleted** in commit `d96b6789e` ("migrate all database
infrastructure into plugins/database/"). The migration runner now lives in
`plugins/database/plugins/migrations/server/internal/runner.ts` and is exported
only as a **library** function `runMigrations(db)` — there is no standalone
`import.meta.main` entry point anymore.

Consequences:
- `mise install` → postinstall hook → `mise run setup` fails its last step with
  `error: Module not found server/src/db/migrate.ts` and a non-zero exit.
- This is currently **masked** whenever the base `singularity` DB already exists
  (migrations were seeded by a prior run / server boot, so nothing downstream
  notices the broken step).
- On a genuine **fresh-clone bootstrap** — the exact case the hook exists for —
  the base DB's `__singularity_migrations` ledger is never seeded, so the first
  `./equin build --allow-main` deadlocks waiting for it (server-core
  CLAUDE.md: "No bootstrap, no auto-seeding").

**Outcome:** restore a runnable entry point that applies pending migrations to
the `SINGULARITY_WORKTREE`-selected DB, and point `mise.toml` at it — faithfully
restoring the old `migrate.ts`-as-script behavior in its correct new home.

## Why a CLI command (not a plugin script or provision step)

- **It can't live in the migrations plugin.** Running migrations needs a
  connected `db`. `db` is exported from `@plugins/database/server`, but the
  database plugin already `Uses` `migrations.runMigrations` — so a migrations →
  database/server import is a **dependency cycle** (forbidden by the no-cycles
  boundary rule). The DB pool + the runner can only be wired together by a
  composition root.
- **The CLI is that composition root.** `plugins/framework/plugins/cli/bin/` is
  exempt from boundary rules and already imports plugin barrels
  (`@plugins/database/server` is legal grammar). It mirrors how the old
  `migrate.ts` doubled as both library and entry — we just split the entry into
  the CLI where it belongs.
- **Not the `provision/` registry.** The provision runner (root `postinstall`)
  is deliberately **alias-free** (`@plugins/*` does not resolve in the
  `bun install` lifecycle context — see
  `plugins/framework/plugins/tooling/plugins/provision/scripts/run-provisions.ts`),
  so it cannot import `runMigrations`. The DB bootstrap already lives in
  `mise.toml`'s setup task (with its `pg_isready` / `createdb` guards); keep it
  there and only fix the invocation.

## Critical constraint: lazy import is mandatory

`plugins/database/server/internal/client.ts` builds its `Pool` **at module
load**:

```ts
const pool = new Pool({ connectionString: buildConnectionString(conn, requireWorktree()), ... });
```

`requireWorktree()` **throws** if `SINGULARITY_WORKTREE` is unset. `bin/index.ts`
imports every command module eagerly, so a **static** `import` of
`@plugins/database/server` from a command file would throw for *every* CLI
invocation that doesn't set the env (`build`, `check`, `push`, …) — breaking the
whole CLI.

→ The new command must **dynamically import** the DB barrel + runner **inside its
action handler** (which only executes for this command, by which point the env is
set). This is the load-bearing detail of the fix.

## Implementation

### 1. New CLI command — `plugins/framework/plugins/cli/bin/commands/apply-migrations.ts`

```ts
import type { Command } from "commander";

export function registerApplyMigrations(program: Command) {
  program
    .command("apply-migrations")
    .description(
      "Apply pending SQL migrations to the DB selected by SINGULARITY_WORKTREE. " +
        "Used by the fresh-clone bootstrap (mise `setup`) to seed the base " +
        "'singularity' DB before the first build; the server otherwise applies " +
        "migrations itself on boot.",
    )
    .action(async () => {
      // Dynamic import: @plugins/database/server builds its pg Pool at module
      // load via requireWorktree(), which throws without SINGULARITY_WORKTREE.
      // A static import here would break every other CLI command. By the time
      // this action runs, the env is set by the caller.
      const { db } = await import("@plugins/database/server");
      const { runMigrations } = await import(
        "@plugins/database/plugins/migrations/server"
      );
      await runMigrations(db);
      console.log("apply-migrations: migrations applied.");
      // The pg Pool keeps the event loop alive; exit explicitly (as the old
      // migrate.ts did).
      process.exit(0);
    });
}
```

Notes:
- `runMigrations(db)` is the existing export from
  `plugins/database/plugins/migrations/server/index.ts`. It creates
  `__singularity_migrations` if absent and applies pending hashes — exactly the
  seeding the bootstrap needs.
- Only `runMigrations` is needed (not `rebuildDerivedTables` /
  `rebuildDerivedViews`); those are derived state the server rebuilds in its own
  `onReadyBlocking` on first boot. This matches the old `migrate.ts` scope.

### 2. Register it — `plugins/framework/plugins/cli/bin/index.ts`

Add the import and `registerApplyMigrations(program)` call alongside the other
`register*` calls.

### 3. Point `mise.toml` at it

In the `[tasks.setup]` `run` block, replace:

```
SINGULARITY_WORKTREE=singularity bun server/src/db/migrate.ts
```

with a direct bin invocation (avoids the extra `bun install` the `./equin`
wrapper would re-run — setup already ran `bun install --silent`):

```
SINGULARITY_WORKTREE=singularity bun plugins/framework/plugins/cli/bin/index.ts apply-migrations
```

Also update the stale references to `migrate.ts`:
- Header comment (lines ~7–9): "apply server migrations directly
  (`server/src/db/migrate.ts` as a script)" → describe the `apply-migrations`
  CLI command.
- The `echo "setup: installing bun deps (needed for migrate.ts imports)..."`
  line (~41) → reword to reference the CLI command's imports.

## Files to modify

- `mise.toml` — fix step-2 invocation + the two stale `migrate.ts` comments.
- `plugins/framework/plugins/cli/bin/commands/apply-migrations.ts` — **new**.
- `plugins/framework/plugins/cli/bin/index.ts` — register the command.

(Optional, low priority: the dangling `server/src/db/migrate.ts` references in
`research/2026-04-13-plugins-conversation-schema.md` are historical design docs —
leave them.)

## Verification

1. **Command exists & is wired:**
   `bun plugins/framework/plugins/cli/bin/index.ts --help` lists
   `apply-migrations`.
2. **Other commands still load** (proves the lazy import didn't regress them):
   `bun plugins/framework/plugins/cli/bin/index.ts --help` runs without throwing
   the `SINGULARITY_WORKTREE env var is required` error.
3. **Boundaries/types pass:**
   `./equin check plugin-boundaries` and `./equin check type-check`
   — confirm the dynamic `@plugins/database/*` imports from the CLI root are
   accepted (CLI bin is in the boundary `exclude` set; dynamic barrel imports are
   the same grammar as static).
4. **Idempotent re-run against the existing DB** (the common, masked case):
   `SINGULARITY_WORKTREE=singularity bun plugins/framework/plugins/cli/bin/index.ts apply-migrations`
   exits 0 and no-ops (all hashes already applied) — confirm via the
   `query_db` MCP tool: `SELECT count(*) FROM __singularity_migrations` against
   the `singularity` DB is unchanged.
5. **Fresh-bootstrap simulation** (optional, destructive — do only if asked):
   drop a throwaway DB, `createdb test_bootstrap`, then run with
   `SINGULARITY_WORKTREE=test_bootstrap` and confirm `__singularity_migrations`
   gets populated and matches the on-disk file set; drop the DB afterward.
6. **End-to-end:** `mise run setup` completes with exit 0 (it currently exits
   non-zero on the missing-module error). On a machine where the base DB already
   exists it should report "already exists" and the migrate step should no-op
   cleanly.

## Risks / notes

- The connection target (system Postgres vs. embedded socket) is **unchanged** —
  the new command imports the same `db` (same `readDatabaseConfig` +
  `buildConnectionString` logic) the old `migrate.ts`'s `./client` used. No
  config-resolution changes.
- `runMigrations` writes to the `migrations` persisted log channel
  (`~/.singularity/.../logs`); harmless in a standalone run.
- If `./equin check plugin-boundaries` rejects the dynamic `await import()`
  of a barrel (unlikely — same module specifier grammar), fall back to a
  top-of-action `await import()` is already used; otherwise gate behind a tiny
  helper module loaded only by the action. STOP and report rather than working
  around an unexpected check failure.
