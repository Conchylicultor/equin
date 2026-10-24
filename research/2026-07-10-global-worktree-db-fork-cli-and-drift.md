# Worktree DB fork: CLI, concurrency-safety, and schema-drift detection

## Context

A worktree's Postgres DB is created by `forkDatabase("singularity", <worktree>)`, called **only** by the `database.fork` graphile job (`plugins/database/plugins/fork/server/internal/fork-job.ts`), which is enqueued **only** from `createConversation` (`plugins/conversations/server/internal/lifecycle.ts:152`). Consequences:

1. **A worktree created outside the standard path** (`git worktree add` + `claude`, no conversation) never gets a DB. There is no command to create one.
2. **`./equin build` then misleads.** `waitForDatabase` (`build.ts:402-435`) polls 60 s for a fork that was never enqueued, then exits(1) telling the user to inspect a `database.fork` job that does not exist.
3. **A forked DB can silently mismatch the worktree's code.** Migrations are forward-only and hash-keyed, so a DB *ahead* of the branch applies nothing (`runner.ts:124-139` logs this as "expected"). That is correct for additive migrations, but if main dropped/renamed a column after the branch point, the worktree's code reads a column the DB no longer has — a runtime crash the boot log only whispers about. 32 of 194 migration files contain `DROP TABLE` / `DROP COLUMN` / `RENAME`.

This plan adds the missing command, makes `forkDatabase` safe for a second concurrent caller, replaces the misleading build failure with an actionable one, and turns the destructive-drift case into a blocking check that forces a rebase.

**Decisions taken (user):**
- CLI: **only `db fork`.** No `drop`/`list`/`--force`/`--from` — the fork is for the exceptional outside-Singularity worktree; add more only when a real use-case appears.
- Build: **fail and print the command**, do not fork inline.
- Drift: **blocking `./equin check`** — the agent rebases to HEAD to pull the migration into its branch.

---

## Change 1 — Lock-free concurrency-safe `forkDatabase`

Adding the CLI gives `forkDatabase` a second caller that can race the standard-path job for the same target. Postgres advisory locks are an explicitly rejected alternative (`research/2026-06-16-global-host-wide-cpu-admission-flock-broker.md:53`; also incompatible with PgBouncer tx-mode pooling). Make it safe **without any lock** by giving each invocation a unique temp DB and letting the final `RENAME` arbitrate. This also fixes a latent bug: `<target>__forking` overflows Postgres's 63-byte `datname` limit for a 63-char worktree name.

**New file** `plugins/database/plugins/admin/server/internal/temp-name.ts`:
```ts
import { createHash, randomBytes } from "node:crypto";

// f_<sha8(target)> — deterministic per target. build's in-flight probe and
// fork.ts (producer) must agree on this exactly, so it is single-sourced here.
export function forkTempPrefix(target: string): string {
  return `f_${createHash("sha256").update(target).digest("hex").slice(0, 8)}`;
}

// f_<sha8>_<rand8>__forking (~28 chars < 63; still endsWith("__forking") so the
// existing fork-temp-sweep needs no change). rand8 makes every INVOCATION's temp
// unique, so two concurrent callers never clobber each other's temp DB. Output is
// hex + "_", satisfying assertSafeName's /^[a-zA-Z0-9_-]+$/.
export function forkTempName(target: string): string {
  return `${forkTempPrefix(target)}_${randomBytes(4).toString("hex")}__forking`;
}
```

**Modify** `plugins/database/plugins/admin/server/internal/fork.ts`:
- `import { forkTempName } from "./temp-name";` and `const temp = forkTempName(target);` (replaces `const temp = \`${target}__forking\``).
- **Delete** the stale-reap `await dropDatabase(temp);` (line 33). With per-invocation temps there is no stale temp of *our own* name to reap; orphan reclamation is solely the sweep's job now.
- Replace the final `RENAME` (line 115) with a first-writer-wins arbiter (mirrors `ensureDatabase`'s existing `42P04` catch at `databases.ts:37-48`):
```ts
try {
  await getAdminPool().query(`ALTER DATABASE "${temp}" RENAME TO "${target}"`);
} catch (err) {
  const dup = err instanceof Error && "code" in err &&
    (err as { code?: string }).code === "42P04"; // duplicate_database
  // Postcondition recheck also covers a tight two-renamer catalog race (23505).
  if (dup || (await databaseExists(target))) {
    await dropDatabase(temp); // drop our loser temp; target already published
    return;
  }
  throw err; // genuine failure (e.g. temp still has live connections) → loud
}
```
- Keep the `databaseExists(target)` fast-path (line 29) unchanged.

**Modify** `plugins/database/plugins/admin/server/index.ts`: add `export { forkTempPrefix } from "./internal/temp-name";` (build's in-flight probe needs it; `forkTempName` stays internal).

**Why this is correct / safe:**
- `ALTER DATABASE … RENAME TO <existing>` raises `ERRCODE_DUPLICATE_DATABASE` (42P04) — same code `CREATE DATABASE` raises, already handled in `ensureDatabase`.
- `pg_dump` of `singularity` runs in one REPEATABLE-READ snapshot and is a pure reader; N concurrent dumps of the same source don't interfere, and each caller renames its **own** unique temp, so no rename perturbs another dump.
- The job's `dedup:{key:target}` is now a wasted-work optimization, not a correctness requirement.

**Accepted trade-off (document in a comment):** a failing target's graphile retries (`maxAttempts:5`) each mint a fresh temp, so up to ~5 orphan `f_*__forking` DBs can accumulate between the 15-min `fork-temp-sweep` runs; a worktree forking while main is down leaves temps until main returns. These are disk cost, not correctness — the sweep's zero-active-connections gate reclaims them.

---

## Change 2 — `./equin db fork`

**New file** `plugins/framework/plugins/cli/bin/commands/db.ts`:
```ts
import type { Command } from "commander";
import { basename } from "node:path";
import { getWorktreeRoot } from "../git/worktree-root"; // new shared helper (below)

export function registerDb(program: Command) {
  const db = program.command("db").description("Worktree database operations");
  db.command("fork")
    .argument("[target]", "database to create (defaults to the current worktree)")
    .description(
      "Fork the main 'singularity' DB into [target]. For worktrees created " +
        "outside Singularity (git worktree add), which get no fork on creation. " +
        "Idempotent: a no-op if the DB already exists.",
    )
    .action(async (target?: string) => {
      const name = target ?? basename(await getWorktreeRoot());
      // Lazy import: bin/index.ts imports every command module eagerly, and the
      // admin barrel transitively evaluates fork-gate.ts, which mkdir's the
      // db-fork flock slot dirs at module load. Keep that off every other command.
      const { forkDatabase } = await import("@plugins/database/plugins/admin/server");
      console.log(`Forking "singularity" → "${name}"...`);
      await forkDatabase("singularity", name);
      console.log(`DB "${name}" ready.`);
    });
}
```
- Nested `db fork` (Commander native). Source hardcoded to `"singularity"` (it always is; no `--from`). No `SINGULARITY_WORKTREE` needed — `getAdminPool()` targets the `postgres` system DB.
- Errors: let `forkDatabase` throw; the top-level convention already surfaces it. (Matches how other commands allow genuine failures to propagate.)

**Modify** `plugins/framework/plugins/cli/bin/index.ts`: `import { registerDb } from "./commands/db";` and `registerDb(program);`.

**New file** `plugins/framework/plugins/cli/bin/git/worktree-root.ts` (mirrors the existing `git/main-repo-root.ts`):
```ts
export async function getWorktreeRoot(): Promise<string> { /* git rev-parse --show-toplevel */ }
```
`build.ts`, `push.ts`, `check.ts`, `regen-migrations.ts`, `regen-generated.ts` each duplicate this (5 copies). Migrating them to the shared helper is a **recommended but optional** cleanup that can land separately to keep this diff focused; `db.ts` uses the new helper from the start.

---

## Change 3 — `build` fails with an actionable message (no inline fork)

**Modify** `plugins/framework/plugins/cli/bin/commands/build.ts`. Replace `waitForDatabase(name)` (step 2d, ~line 900) and delete its misleading 60 s `onDeadline` block. New helper (reuses the existing `databaseReady()` in this file and `retryUntil`/`fixed`):
```ts
async function waitForWorktreeDatabase(name: string): Promise<void> {
  if (await databaseReady(name)) return; // standard path, ~always already done

  const { listDatabases, forkTempPrefix } =
    await import("@plugins/database/plugins/admin/server");
  const inFlight = (await listDatabases()).some((d) =>
    d.startsWith(forkTempPrefix(name)),
  );

  if (inFlight) {
    // A fork is actively restoring (temp DB exists). Be patient.
    const done = await retryUntil(
      async (a) => {
        if (await databaseReady(name)) return true;
        if (a === 0) console.log(`DB fork for "${name}" in progress; waiting…`);
        return null;
      },
      { delay: fixed(1_000), deadline: 120_000, onDeadline: () => false },
    );
    if (done) return;
    console.error(
      `ERROR: DB fork for "${name}" did not finish within 120s. The database.fork ` +
        `job may be dead — check /api/jobs on the main app.`,
    );
    process.exit(1);
  }

  // No DB and no restore in flight. Either a standard-path job is still queued/
  // gated, or this worktree was created outside Singularity and has no job at
  // all. Grace-poll briefly for the queued case, then fail actionably.
  const done = await retryUntil(
    async (a) => {
      if (await databaseReady(name)) return true;
      if (a === 0) console.log(`Waiting for DB fork "${name}"…`);
      return null;
    },
    { delay: fixed(1_000), deadline: 20_000, onDeadline: () => false },
  );
  if (done) return;
  console.error(
    [
      `ERROR: no database for "${name}" and no fork in flight.`,
      "",
      "If this worktree was created outside Singularity (git worktree add),",
      "create its database with:",
      "",
      "    ./equin db fork",
      "",
      "Then re-run ./equin build.",
    ].join("\n"),
  );
  process.exit(1);
}
```
Call it at the same step 2d in place of `waitForDatabase(name)`. Delete the old `waitForDatabase`.

- **No inline fork, no deadlock risk, no new build-lock interaction** — build never calls `forkDatabase` itself.
- The in-flight probe gives hand-made worktrees a ~20 s failure instead of the old 60 s, and gives genuine restores 120 s of patience.

---

## Change 4 — Blocking schema-drift check

A worktree whose branch predates a **destructive** migration on main has a DB its code can crash against. Make it a blocking `Check` (fails `build`'s check pass and `push`). Scope tightly to **destructive-and-classifiable-on-main** so additive-behind worktrees (the common case) still pass and the failure is always fixable by a rebase.

### 4a. Pure classifier (with test)

**New file** `plugins/database/plugins/migrations/core/internal/destructive.ts`:
```ts
export type DestructiveKind =
  | "drop-table" | "drop-column" | "rename";       // HARD: old name gone → code crash
export interface DestructiveClassification {
  destructive: boolean;                            // any HARD kind present
  statements: Array<{ kind: DestructiveKind; text: string }>;
}
export function classifyMigrationSql(sqlText: string): DestructiveClassification;
```
Comment-strip, then case-insensitive scan for `DROP TABLE`, `DROP COLUMN`, and `ALTER TABLE … RENAME` (table or column). `destructive` = any HARD statement found. (Deliberately excludes soft reshapes like `DROP CONSTRAINT` / `ALTER COLUMN … TYPE` / `SET NOT NULL` from the *blocking* set — they rarely crash a read path; revisit if needed.)

**New file** `plugins/database/plugins/migrations/core/internal/destructive.test.ts` (`bun:test`): additive `CREATE TABLE` / `ADD COLUMN` → `destructive:false`; `DROP COLUMN` / `DROP TABLE` / `RENAME COLUMN` → `true` with the right `kind`; commented-out DDL → ignored.

**Modify** `plugins/database/plugins/migrations/core/index.ts`: export both.

### 4b. The check

**New file** `plugins/database/plugins/migrations/check/fork-schema-drift.ts`, added to the `Check[]` default-exported from `plugins/database/plugins/migrations/check/index.ts`. Model it on the existing `migration-applies-clean` check in that file (same `Check` shape, same `buildConnectionString`/`readDatabaseConfig` from `@plugins/database/core` connection pattern, same local `git` spawn helper):

```
id: "fork-schema-drift"
description: "worktree DB carries no destructive migration absent from this branch"
run():
  1. worktree name = basename(git rev-parse --show-toplevel).
  2. Connect (direct, max:1) to DB `<worktree name>`. Read the ledger:
       SELECT hash, file FROM __singularity_migrations
     (MIGRATIONS_TABLE_NAME from @plugins/database/plugins/derived-views/core).
     If the table/DB is absent → { ok: true } (fresh, nothing forked yet).
  3. onDiskHashes = sha8 group of every filename under
     plugins/database/plugins/migrations/data on THIS branch (MIGRATION_RE).
  4. mainRoot = ensureMainWorktreeRoot() (@plugins/infra/plugins/worktree/server).
     For each ledger row whose hash ∉ onDiskHashes:
       read <mainRoot>/plugins/database/plugins/migrations/data/<file>;
       if present → classifyMigrationSql; collect if destructive.
       if absent on main too → IGNORE (locally-authored then rebased away; a
         rebase can't fix it, so blocking would be unactionable).
  5. If any destructive collected → { ok: false, message: <files + dropped objects>,
       hint: "This worktree's DB has migrations your branch lacks that DROP/RENAME
              schema your code may still use. Rebase onto main to pull them in:
              git fetch origin main && git rebase origin/main" }.
     Else { ok: true }.
```
`cacheSignature()`: fold the `data/` filenames + `git rev-parse origin/main` (same idiom as `migration-applies-clean`), best-effort `try/catch → null`.

**Zero cost on the common path:** a fresh or fully-current worktree has no applied-hash-with-no-file, so step 4's loop is empty; only an aged worktree pays a handful of file reads.

**Why blocking is right here:** it fires *only* when main destructively changed schema the branch hasn't pulled in — exactly the case a rebase fixes and exactly the case that crashes at runtime. Rebasing pulls the migration file into the branch, so the hash is no longer "applied-but-no-file" and the code now matches the DB.

---

## Implementation order

1. **Change 1** — `temp-name.ts`, `fork.ts` edits, barrel export. Foundation.
2. **Change 4a** — `destructive.ts` + test + core export. Pure, independent; `bun test` immediately.
3. **Change 2** — `git/worktree-root.ts`, `commands/db.ts`, `index.ts` wiring. Depends only on existing admin exports.
4. **Change 3** — `waitForWorktreeDatabase` in `build.ts` (needs `forkTempPrefix` from step 1).
5. **Change 4b** — `fork-schema-drift.ts` + register in `migrations/check/index.ts` (needs the classifier from step 2).

## Critical files

- `plugins/database/plugins/admin/server/internal/fork.ts` (+ new `temp-name.ts`, barrel `index.ts`)
- `plugins/framework/plugins/cli/bin/commands/db.ts` (new), `bin/index.ts`, `bin/git/worktree-root.ts` (new)
- `plugins/framework/plugins/cli/bin/commands/build.ts`
- `plugins/database/plugins/migrations/core/internal/destructive.ts` (+ test), `core/index.ts`
- `plugins/database/plugins/migrations/check/fork-schema-drift.ts` (new), `check/index.ts`

## Verification

- **Classifier:** `bun test plugins/database/plugins/migrations/core/internal/destructive.test.ts`.
- **Change 1 idempotent + concurrent:** on a throwaway target — fork it, confirm via `mcp__singularity__query_db` (`SELECT datname FROM pg_database WHERE datname='<t>' OR datname LIKE 'f\_%'`) that the target exists and no `f_*` temp lingers; run two `./equin db fork <t>` in parallel after dropping it → both exit 0, exactly one `<t>`, loser temp gone (or reaped). Re-fork an existing target → instant no-op.
- **Change 2:** `./equin db fork` in a hand-made worktree creates its DB; a second run is a no-op.
- **Change 3:** drop the current worktree's DB, run `./equin build` → it prints the `./equin db fork` hint and exits 1 (not the old 60 s job message). Create the DB, re-run → build proceeds.
- **Change 4 blocking:** point a worktree whose branch predates a destructive migration on main at `./equin check fork-schema-drift` → fails, naming the migration + dropped object, with the rebase hint. A fully-current worktree → passes. After `git rebase origin/main` → passes.
- **Regression:** `./equin check` and a normal `./equin build` (tsc covers the new `cli/bin` and `migrations/core` modules).
