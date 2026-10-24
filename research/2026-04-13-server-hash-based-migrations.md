# Hash-based Migration Filenames

## Context

Today migrations live in `server/src/db/migrations/` with Drizzle's default `NNNN_<word>_<word>.sql` scheme, indexed by a sequential `NNNN`. Order and identity are tracked in `meta/_journal.json` (an ordered array of `{ idx, tag, when }` entries) and `meta/NNNN_snapshot.json` (the post-state of each migration).

This format does not survive parallel agents. Two worktrees branching off the same main both:

- generate `0001_*.sql` — different SQL, same slot
- append a journal entry at `idx: 1` — array conflict on merge
- write `meta/0001_snapshot.json` — same path, different content

Every parallel schema change becomes a manual git merge, even when the two changes are semantically independent (e.g. `ADD COLUMN` on different tables). This blocks the agent-manager's core promise of independent worktrees.

The followup doc ([`2026-04-12-global-database-followups.md`](./2026-04-12-global-database-followups.md), "Parallel-agent migration merge") flagged content-hash filenames as the headline fix. This plan implements step 1 (hash filenames) + step 3 (regenerate journal at build time). Steps 2, 4, 5 (topo-sort, additive enforcement, backfills) remain deferred.

## Design

### Filename format

```
<YYYYMMDDHHMMSS>_<sha256[:8]>__<name>.sql
e.g.  20260413_142307_8f3d9c01__add_todos_status.sql
```

- `YYYYMMDDHHMMSS` — UTC timestamp. Lexically sortable AND human-readable at a glance ("this migration was authored on April 13"). Underscore between date and time for readability.
- `sha256[:8]` — first 8 hex chars of `sha256(sql_body)`. The migration's identity. Two agents producing identical DDL converge to the same file → git auto-dedupes.
- `name` — short slug describing the change (see below). Double underscore separator so the hash is greppable.

### Where the name comes from

Drizzle's default `volatile_orphan` is a random adjective+noun picked by `drizzle-kit` when no `--name` is passed. It carries zero meaning. We require the agent to provide one explicitly, and **fail the build** if a migration would be produced without one.

**Detection** (pre-flight in `build.ts`, before `drizzle-kit generate`):

Run `drizzle-kit generate` in **dry-run** mode. Drizzle-kit doesn't ship a `--dry-run` flag, but the equivalent is:

1. Snapshot the current `migrations/` dir contents (filenames).
2. Run `drizzle-kit generate` with no `--name`.
3. Compare: any new `.sql` file means schema diverged from the latest snapshot.

If a new file appeared **and** no `--migration-name` was passed: delete the just-generated file + its snapshot + the journal entry, and exit with:

```
Error: schema.ts changed and would generate a new migration, but --migration-name was not provided.
Re-run with:
  ./equin build --migration-name <short_slug>
e.g. --migration-name add_todo_status
```

If a new file appeared and `--migration-name` *was* passed: re-run `drizzle-kit generate --name <slug>` (so the base filename carries the slug), then proceed to the hash-rename step.

If no new file appeared: `--migration-name` is ignored (warn if it was passed redundantly). No-op builds stay no-op.

This forces every schema change to be consciously named by the agent, and surfaces unintentional schema drift (e.g. accidental edit to `schema.ts`) as a build failure rather than a silent `volatile_orphan` commit.

This subsumes the "Readable migration names" item from the followup doc.

### Generate flow (in `./equin build`)

`build.ts` currently shells out to `drizzle-kit generate` (step 2, line 63-67). After that call:

1. Glob `server/src/db/migrations/*.sql` for files matching the *old* `NNNN_*.sql` pattern (i.e. just produced by drizzle-kit, not yet renamed).
2. For each: read SQL, compute hash, rename to the new format. Also rename `meta/NNNN_snapshot.json` → `meta/<hash>_snapshot.json`.
3. Regenerate `meta/_journal.json` from scratch by scanning all files in the migrations dir, sorted by the timestamp prefix. Entries become `{ tag: <full-filename-without-ext>, hash, when: <ms-from-prefix> }`. Drop the `idx` field — order is derived, not stored.

This keeps Drizzle's generator untouched (still our source of truth for diffing `schema.ts`) — we just rewrite its output into a merge-friendly shape.

### Apply flow (replace `drizzle-orm/postgres-js/migrator`)

Drizzle's bundled migrator reads `_journal.json` and applies in journal order, tracking applied hashes in `__drizzle_migrations`. We replace it with ~30 lines in `server/src/db/migrate.ts`:

1. Ensure `__singularity_migrations(hash text primary key, applied_at timestamp default now())` exists.
2. Glob `migrations/*.sql`, parse `(timestamp, hash, name)` from each filename.
3. Sort by timestamp prefix (lexical). Note: this is *authoring* order, used as a heuristic. Additive-only DDL commutes, so any order works for the MVP. Topological sort is the followup.
4. For each: `SELECT 1 FROM __singularity_migrations WHERE hash = $1`. Skip if present.
5. Otherwise: run the SQL inside a transaction, insert the hash row, commit.

We use our own table (not `__drizzle_migrations`) to make the schema-change explicit and decouple from Drizzle's internal format.

### Merge order on main

After two agents merge into main with hash files `H_a` (timestamp T1) and `H_b` (timestamp T2, T2 > T1):

- Files coexist: `20260413_100000_H_a__….sql`, `20260413_140000_H_b__….sql`. No filename collision (different hashes).
- Journal regenerates from the file set on the next `./equin build` (deterministic — both agents/CI produce the same journal). Not a merge conflict source.
- On `runMigrations()` against an existing main DB that already applied `H_a`: the migrator sees `H_a` in `__singularity_migrations`, skips it, applies `H_b`. Against a fresh DB: applies both in `(T1, T2)` order.
- Against agent A's DB *before* it pulled main: `H_a` already applied; pulling adds `H_b`; next start applies `H_b`. Order on A's DB is `[H_a, H_b]`. On B's DB before pull: `[H_b]`, then after pull `[H_b, H_a]`. **Different application orders across DBs** — safe under the additive-only assumption, unsafe otherwise. This is why followup item 4 (additive-only enforcement) becomes load-bearing once this lands.

## Files

- `cli/src/commands/build.ts` — after the `drizzle-kit generate` call (line 63-67), invoke a new `renameMigrations()` helper.
- `cli/src/migrations-rename.ts` *(new)* — pure function: read dir, hash, rename files + snapshots, rewrite `_journal.json`. Importable by both `build` and a future `check`.
- `server/src/db/migrate.ts` — replace the `drizzle-orm/postgres-js/migrator` call with the custom apply loop described above.
- `server/src/db/migrations/0000_volatile_orphan.sql` + `meta/` — rename in-place as part of this PR (one-time migration of the existing single migration). The hash of its current SQL becomes its new identity. The DB on existing worktrees has `__drizzle_migrations` rows that won't match `__singularity_migrations`; handled by a one-shot bootstrap: if `__singularity_migrations` is empty *and* `__drizzle_migrations` has rows, seed `__singularity_migrations` from the on-disk hash list (assume already-applied) before the apply loop runs.
- `cli/src/checks/migrations-in-sync.ts` — keep working; the rename is deterministic so `drizzle-kit generate` followed by rename is idempotent.

## Verification

1. **Round-trip a schema change.** Edit `plugins/<x>/server/schema.ts` to add a column. Run `./equin build`. Confirm:
   - New file matches `^[a-z0-9]+_[0-9a-f]{8}__.*\.sql$`.
   - `meta/_journal.json` has no `idx` field and lists files in timestamp order.
   - Server starts; `__singularity_migrations` contains the new hash.
   - Re-run `./equin build` → no new file generated, server start is a no-op (idempotent).

2. **Simulate parallel agents.** From main, branch twice:
   - In worktree A: add column `a` to a table, build.
   - In worktree B (separate): add column `b` to a different table, build.
   - Merge both into a scratch branch with `git merge`. Expect zero conflicts (different filenames, journal regenerated on next build).
   - Build the merged branch, start server, confirm both columns exist.

3. **Bootstrap path.** On a worktree predating this change (DB has `__drizzle_migrations` rows, none in `__singularity_migrations`), start the server and confirm the bootstrap seeds the table without re-running migrations (no duplicate-table errors).

4. **Check command.** `./equin check --migrations-in-sync` still passes after a clean build.

## Out of scope (deferred to followup doc)

- Topological apply order by DDL dependency
- Additive-only DDL enforcement (`--allow-destructive`)
- Per-migration backfill hooks
