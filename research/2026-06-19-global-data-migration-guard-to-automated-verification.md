# Retire the `.allow-migrations` human gate → automated transactional dry-run

## Context

Durable data mutations (e.g. "delete the malformed `attempts` rows") have exactly
one sanctioned mechanism in this repo: a **data/backfill migration**
(`./equin build --custom-migration --migration-name <slug>`) — version
controlled, reviewable, idempotent, applied once to main and every fork on next
boot. That part is correct and stays.

The problem is the **gate** around it. Creating a custom migration is blocked by a
Claude Code PreToolUse guard (`migrationsGuard`) whose only escape is for the
agent to create a gitignored `$PWD/.allow-migrations` file. That gate is:

- **Self-attested & forgeable** — the agent creates the very file that grants the
  permission. A gate whose key is "touch this file yourself" is a speed bump.
- **Invisible to review** — `.allow-migrations` is gitignored, so no durable record
  of approval travels with the change.
- **Vestigial.** Git history shows *why* the guard was added (`0baacfc43`, May 16,
  "prevent orphan SQL files from reaching main"): agents were using
  `--custom-migration` to hand-roll **schema DDL** that drifted from `schema.ts`,
  orphaned files onto main, and broke the snapshot chain. Every one of those
  failure modes was later closed **structurally** by `958318ebb` (Jun 2):
  - schema-drift → `data-migration-dml-only` check (default-deny DML allowlist;
    a snapshot-less migration provably cannot change the schema),
  - snapshot Y-fork → snapshot decoupling (push-safe regardless of main movement),
  - silent-skip on edit → `rehashBranchLocalDataMigrations` (filename hash always
    tracks content).

  The guard now blocks a class of harm that can no longer occur, while still
  imposing a forgeable human gate.

**Intended outcome (the user's bar):** agents push *anything that doesn't break the
main app* freely, with **no human approval step**; the one genuine remaining risk —
a migration that **fails to apply** and therefore crashes main's boot
(`onReadyBlocking`) — is **detected and blocked automatically before push**.

So: remove the human gate, and replace it with an automated check that proves the
pending migration applies cleanly. The check must be fast enough to run on every
push (the earlier fork-the-DB / boot-a-server ideas were rejected as too slow).

## Approach

Two independent pieces.

### Piece 1 — Retire the vestigial guard + `.allow-migrations` surface

- **`plugins/framework/plugins/tooling/plugins/guards/core/guards/migrations.ts`**
  Remove the `--custom-migration` block (lines 24–33) and the
  `bypassToken: ".allow-migrations"` (line 8). **Keep** the `rm migrations/data/`
  block (lines 12–21) — that protection is unrelated and still valid. Result: the
  guard becomes "refuse to hand-delete migration files," nothing else.
- **`.../allow-monitor/server/internal/allow-files-handler.ts`** (line 6) — drop
  `".allow-migrations"` from `ALLOW_FILES` (leaving `.allow-main`, `.allow-postgres`).
- **`.../allow-monitor/web/index.ts`** (line 7) + **`.../allow-monitor/CLAUDE.md`** —
  remove `.allow-migrations` from the description prose.
- **`.gitignore`** (line 50) — remove the `.allow-migrations` entry.
- **`plugins/database/plugins/migrations/CLAUDE.md`** — rewrite the "Data / backfill
  migration" bullet: drop "gated by `.allow-migrations`, requires user approval";
  state that data migrations are created freely with `--custom-migration` and that
  two checks back them up — `data-migration-dml-only` (no schema changes) and the
  new `migration-applies-clean` (proves they apply). Keep the "backfill that must
  precede a schema change" section.

`--custom-migration` itself stays (the user chose to keep the flag); we only remove
the guard that blocked it. The backstop against the original abuse (hand-rolled
schema DDL via `--custom`) remains `data-migration-dml-only`, which fails loudly at
check/push time.

### Piece 2 — Automated transactional dry-run check

Verify that the migrations in the worktree apply cleanly **on top of main's current
state**, by replaying only the pending delta inside a transaction that is always
rolled back. No DB copy, no server boot.

**Why a transaction against live main (not a fork):** the only "breaks-main" failure
for a migration is that it errors during `onReadyBlocking` → server never comes up.
Applying the pending delta against main's real schema + real data reproduces that
exactly. Postgres DDL and DML are both transactional; `LISTEN/NOTIFY` only delivers
on commit; a crashed process auto-aborts. So a `ROLLBACK`-wrapped apply is
side-effect-free, and `SET LOCAL lock_timeout`/`statement_timeout` bound any lock
window so it can never disrupt live main.

**Refactor the runner** to share its core (clean-design, not a copy):
`plugins/database/plugins/migrations/server/internal/runner.ts`
- Extract `listMigrationFiles(dir)` → ordered `[{hash, file, sql}]` and
  `getAppliedHashes(db)` from the existing `runMigrations`.
- `runMigrations(db)` keeps current behavior (per-migration commit + ledger insert).
- Add `dryRunPendingMigrations(db)`:
  ```ts
  const applied = await getAppliedHashes(db);
  const pending = listMigrationFiles(dir).filter(m => !applied.has(m.hash));
  if (pending.length === 0) return { pending: 0 };
  const sentinel = Symbol();
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '60s'`);
      for (const m of pending) await tx.execute(sql.raw(m.sql)); // throws -> caught
      await rebuildDerivedViews(tx);          // mirrors onReadyBlocking's next step
      throw sentinel;                          // force ROLLBACK; never commit
    });
  } catch (e) { if (e !== sentinel) throw e; } // real failure -> propagate with file ctx
  return { pending: pending.length };
  ```
  On a real apply failure, surface **which file** failed and the pg error message.
  Pending migrations run in one transaction so a later migration sees an earlier
  one's DDL (same as boot's net effect for "does it apply").

**The check** — new `plugins/database/plugins/migrations/check/index.ts`
(plugin-contributed `Check`, auto-discovered; id `migration-applies-clean`):
1. **Fast path:** if `git diff --quiet origin/main -- plugins/database/plugins/migrations/data`
   → no pending migrations → `{ ok: true }`, no DB connection. (Zero cost on the
   ~99% of pushes that touch no migration.)
2. Else open a **direct** connection to the main DB and dry-run:
   ```ts
   const pool = openShortLivedClient(MAIN_DB_NAME); // direct PG, bypasses pgbouncer
   try { await dryRunPendingMigrations(drizzle(pool)); }
   finally { await pool.end(); }
   ```
   - `MAIN_DB_NAME` = the `singularity` main DB constant
     (`@plugins/database/plugins/embedded/shared` — confirm exact export).
   - Success → `{ ok: true }`. Throw → `{ ok: false, message: "<file>: <pg error>",
     hint: "Fix the migration SQL; it would crash main's boot." }`.
   - If the DB is unreachable while a migration *is* pending → **fail loudly**
     (don't pass an unverified migration). On `lock_timeout` specifically, retry
     once, then fail.
   - `cacheSignature()`: hash of the `data/` dir content + `git rev-parse origin/main`
     so an unchanged input caches.

This check runs uniformly in `./equin build`, `./equin check`, and the
push checks step (`runChecksUnderPushSlot`, push.ts step 8) — which already runs
**after** rebase + `regen-migrations` normalize, i.e. exactly when the branch-local
migration set is final and `origin/main` is fresh.

## Critical files

| File | Change |
|---|---|
| `plugins/framework/plugins/tooling/plugins/guards/core/guards/migrations.ts` | remove `--custom-migration` block + `bypassToken`; keep `rm` block |
| `plugins/conversations/plugins/conversation-view/plugins/allow-monitor/server/internal/allow-files-handler.ts` | drop `.allow-migrations` from `ALLOW_FILES` |
| `plugins/conversations/plugins/conversation-view/plugins/allow-monitor/web/index.ts` + `CLAUDE.md` | description prose |
| `.gitignore` | remove `.allow-migrations` |
| `plugins/database/plugins/migrations/server/internal/runner.ts` | extract `listMigrationFiles`/`getAppliedHashes`; add `dryRunPendingMigrations` |
| `plugins/database/plugins/migrations/check/index.ts` | **new** — `migration-applies-clean` check |
| `plugins/database/plugins/migrations/CLAUDE.md` | rewrite data-migration bullet |

## Reused primitives (no new machinery)

- `runMigrations` / migration runner — `plugins/database/plugins/migrations/server/internal/runner.ts:46`
- `rebuildDerivedViews(db)` — `@plugins/database/plugins/derived-views/server` (called in `onReadyBlocking`)
- `openShortLivedClient(dbName)` — `plugins/database/plugins/admin/server/internal/pool.ts:58` (direct PG, pool max 1 → single-client tx)
- `Check` interface + auto-discovery — `plugins/framework/plugins/tooling/core/types.ts`; collected via `check.generated.ts` (regenerated by build)
- `data-migration-dml-only` check (unchanged backstop) — `.../checks/plugins/data-migration-dml-only/check/index.ts`

## Verification

1. **Guard gone:** `./equin build --custom-migration --migration-name probe_noop`
   succeeds with **no** `.allow-migrations` present (previously blocked). Hand-edit the
   generated SQL to a harmless `SELECT 1;`, rebuild — applies, dml-only check passes.
2. **Check catches a bad migration:** hand-edit a pending data migration to reference a
   non-existent column (e.g. `UPDATE attempts SET nope = 1;`). Run
   `./equin check migration-applies-clean` → **FAILS**, message names the file +
   pg error. Confirm via `query_db "SELECT count(*) FROM attempts"` that the dry-run left
   **no** data change (rolled back). Fix the SQL → check passes.
3. **Fast path:** on a branch with no `data/` changes vs `origin/main`,
   `./equin check migration-applies-clean` passes instantly (no DB connection —
   confirm via timing / no slow-op).
4. **Push integration:** `./equin push -m "..."` on a branch with a valid data
   migration passes the checks step; with a deliberately broken one, push aborts at the
   checks step before `push-branch`.
5. **allow-monitor:** with `.allow-migrations` removed from `ALLOW_FILES`, creating that
   file no longer raises the conversation `BYPASS ACTIVE` chip (`.allow-main` still does).

## Out of scope / future

- Renaming `--custom-migration` to a dedicated `./equin migrate:data` verb
  (user chose to keep the flag for now).
- Catching *semantic* breakage (migration boots fine but corrupts data a feature needs)
  — that's a broader smoke/health-coverage lever, not this gate.
- If main's DB ever grows large enough that a pending migration's own runtime is a push
  concern, the dry-run is still bounded by `statement_timeout`; no copy cost is added.
