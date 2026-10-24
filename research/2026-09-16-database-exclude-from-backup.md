# ExcludeFromBackup — leaving rebuildable or expiring table rows out of backups

Implements section "5. Backups" of
[`2026-09-16-apps-chord-trainer-song-index-v2.md`](2026-09-16-apps-chord-trainer-song-index-v2.md),
the step listed there as "New step, before the song index". Chord trainer track
page: `block-49ba706c-affe-417b-a9a1-b6873e8c7ea8`.

## Context

A nightly backup runs `pg_dump -Fc` on every database that is not a worktree's,
and copies every table's rows. A plugin has no way to say "my rows can be left
out", although forks have had one for a while (`ExcludeFromFork`).

So `traces` goes into every backup. It is 7 days of debugging evidence, swept
nightly, and already left out of forks. Today it is 591 MB on disk in main's
1707 MB database (the fork doc measured 949 MB earlier).

The chord trainer song index will need the same option for its three cache
tables, which are rebuilt from a snapshot file.

**Outcome:** a plugin declares `ExcludeFromBackup({ table, reason })`. The backup
keeps that table's structure and leaves out its rows. `traces` is the first
declaration. The backup gets smaller by roughly the compressed size of `traces`.

### Baseline, measured on main (backup_runs, 2026-09-16 03:00)

| | bytes |
|---|---|
| Whole archive | 796,782,892 (≈797 MB) |
| Databases source (all dumps) | 686,666,705 (≈687 MB) |
| The two runs before | 797.9 MB / 698.0 MB, 800.7 MB / 697.0 MB |

The manifest records one size for all dumps together, not one per database. The
per-database "before" for `singularity.dump` is measured at implementation time
(step 6).

## Design

### 1. The declaration — `database/admin`

New file `plugins/database/plugins/admin/server/internal/backup-exclusion.ts`, the
twin of `fork-exclusion.ts`:

```ts
export const ExcludeFromBackup = defineServerContribution<{
  table: PgTable | string;
  reason: string;
}>("backup-data-exclusion", { docLabel: (c) => tableLabel(c.table) });

export interface BackupExclusions { readonly tables: readonly string[] }
export function backupExclusions(): BackupExclusions
```

- **Table-level only.** No schema-level form. Nothing needs one today, and
  Zero's and graphile's schemas are small. It can be added later the same way as
  for forks.
- **A separate declaration from `ExcludeFromFork`, on purpose.** Fork asks "does
  a worktree need these rows?". Backup asks "does losing these rows cost
  anything?". The answers differ (v1.1: `mail_sync_state` is in forks but out
  of backups).
- **`reason` must say one of two things:** how the rows come back, or why losing
  them costs nothing (they expire). The comment on the token says so, with
  `traces` and the chord trainer caches as the two examples.
- **`backupExclusions()` throws when nothing is registered**, like
  `forkExclusions()`. `traces` guarantees at least one declaration in any process
  that collected contributions. An empty set means the caller never booted the
  plugins, and it would silently produce a full backup. The backup body runs in
  `./equin supervised-exec`, which does collect contributions (checked in
  `supervised-job`'s task registry), so it sees the declarations.
- `tableLabel` moves to a small shared helper in `internal/` so both token
  files use it.

### 2. Matching against the catalog — one shared planner

Today `fork-plan.ts` holds the catalog read (`readSchemaCatalog`), the pattern
quoting, and the table rule: a table must exist in `public`, and a partitioned
table is expanded to its leaves. A missing table goes into `unmatched` as a
warning, not an error.

Backups need exactly that table rule, and nothing about schemas. So:

- **New file `internal/catalog-plan.ts`**, taking out of `fork-plan.ts`:
  `SchemaCatalog` / `CatalogSchema`, `readSchemaCatalog` and its row schema,
  `quotePatternPart` / `tablePattern`, and a new pure function:

  ```ts
  planTableExclusions(catalog, tables): {
    excludeTableData: string[];   // quoted "public"."t" + every partition leaf
    excludedTables: string[];     // the relation names, for the manifest
    unmatched: string[];
  }
  ```

- `planForkExclusions` calls `planTableExclusions` for its table part. Its
  behaviour does not change, and the existing `fork-plan.test.ts` must pass
  untouched.
- **New `internal/backup-plan.ts`**: `planBackupExclusions(catalog, exclusions)`
  (pure) and `resolveBackupPlan(source, exclusions)`.

This is what "a stale name fails the same way it does for forks" means: the
name is checked against the real database, and a miss is reported, not fatal. A
miss is normal here too. The backup covers composition databases (`sonata`,
`website`) whose schema may not have `traces`, and a branch may declare a table
before main has run its migration.

### 3. Running the backup — `backupDatabase`

`backupDatabase(name, outFile)` becomes
`backupDatabase(name, outFile, exclusions): Promise<BackupPlan>`.

- **The exclusions are a required argument**, as in `forkDatabase`. A caller
  cannot forget them. The test can also pass its own set without going through
  contributions.
- It resolves the plan against that database, logs each `unmatched` line with
  `console.warn` (it lands in the backup transcript), then runs
  `pg_dump -Fc -f <outFile> --exclude-table-data=<pattern>… <name>`.
- Switch from raw `Bun.spawn` with `stdout: Bun.file(...)` to `spawnCaptured` with
  `-f`, the way `fork.ts` does it. `fork.ts` documents why: Bun can drop the tail
  of a streamed dump. `background: true` so the dump yields CPU to the
  interactive backends. Bounded by `unbounded: "…"` like the fork, since the
  backup child has no deadline.
- It returns the plan, so the caller can put the findings in the manifest.

### 4. The manifest must not claim rows that are not in the archive

`inspectBackup` reads row counts from the live database (`pg_stat_user_tables`),
not from the dump. After this change it would still count `traces`' rows as
backed up.

- `inspectBackup(file, name, excludedTables)` marks those tables:
  `TableStat` gets `rowsExcluded: boolean`, and their rows are not added up.
- `assembleDatabases` (`backup/sources/databases`) passes `backupExclusions()`,
  and the item detail reads e.g.
  `135 tables / 71934 rows (rows of 1 table left out: traces)`.

### 5. `traces` declares it

In `plugins/debug/plugins/trace/plugins/engine/server/index.ts`, next to its
`ExcludeFromFork`:

```ts
ExcludeFromBackup({
  table: _traces,
  reason:
    "7-day debugging evidence, swept nightly; a restore a week later would find it expired anyway.",
}),
```

### 6. Docs

- `database/admin/CLAUDE.md`: a "Backup exclusions" section next to the fork one:
  the two questions, the `reason` rule, and that a restore gives an empty table
  (so the owning plugin must handle the empty case — the song index reloads).
- The comment in `fork-exclusion.ts` that names `traces` as a fork example gets a
  pointer to the backup twin.

## Files

| File | Change |
|---|---|
| `plugins/database/plugins/admin/server/internal/backup-exclusion.ts` | new — token + `backupExclusions()` |
| `plugins/database/plugins/admin/server/internal/catalog-plan.ts` | new — catalog read, quoting, `planTableExclusions` (moved out of `fork-plan.ts`) |
| `plugins/database/plugins/admin/server/internal/backup-plan.ts` | new — `planBackupExclusions`, `resolveBackupPlan` |
| `plugins/database/plugins/admin/server/internal/fork-plan.ts` | uses `catalog-plan.ts` |
| `plugins/database/plugins/admin/server/internal/backup.ts` | exclusions argument, `spawnCaptured`, manifest marking |
| `plugins/database/plugins/admin/server/index.ts` | export `ExcludeFromBackup`, `backupExclusions`, `BackupExclusions`, `BackupPlan` |
| `plugins/backup/plugins/sources/plugins/databases/server/internal/assemble-databases.ts` | pass exclusions, new detail text |
| `plugins/debug/plugins/trace/plugins/engine/server/index.ts` | declare for `traces` |
| `plugins/database/plugins/admin/CLAUDE.md` | docs |

## Tests

1. **Pure, in `admin`** — `backup-plan.test.ts`, same style as
   `fork-plan.test.ts` (hand-built catalog; `admin` cannot use the DB fixture
   without a cycle): a declared table gives one quoted pattern; a partitioned
   table gives the parent plus every leaf; a missing table goes to `unmatched`
   and emits nothing; a mixed-case name is quoted.
2. **Real round trip, in `backup/sources/databases`** —
   `server/internal/backup-exclusion.test.ts` with `createTestDb` (that plugin
   already imports `admin`, so no cycle). Create two tables with rows (via
   `runMigrations`, so `traces` and `tasks` exist with real DDL; insert a row in
   each). Call `backupDatabase(db, file, { tables: ["traces"] })`. `pg_restore`
   into a second throwaway database. Check: `traces` exists and is empty; `tasks`
   has its row; `inspectBackup` marks `traces` as `rowsExcluded`.

Run: `./equin test plugins/database/plugins/admin plugins/backup/plugins/sources/plugins/databases`.

## Verification

1. `./equin build` (background), checks pass.
2. Before/after on this machine, before pushing: `pg_dump -Fc singularity` with and
   without `--exclude-table-data='"public"."traces"'` into the scratchpad, and
   record both file sizes here. This is the per-database number the manifest
   does not keep.
3. After the user pushes: trigger a manual backup on main (or wait for the 03:00
   run). Read `backup_runs` on main with `query_db`: the databases source size and
   the archive size, against the baseline above. The `singularity` item's detail
   names `traces` as left out.
4. Record the before/after numbers in this doc and on the chord trainer track
   page.

## v1.1: mail

The Gmail mirror is the other big rebuildable block in `singularity.dump`, so
`mail-core` now declares `ExcludeFromBackup` for it too.

**Left out** (on main: messages 781 MB, threads 35 MB, message_labels 21 MB,
attachments 9 MB — about 846 MB on disk):

| Table | Why |
|---|---|
| `mail_messages`, `mail_threads`, `mail_message_labels`, `mail_attachments` | A mirror of Gmail. The next sync refetches it. |
| `mail_sync_state` | The history watermark. It has to go with the corpus: bootstrap never resets a row that already has a watermark, so a restored watermark over empty tables would leave the mailbox empty forever. |

**Kept:** `mail_accounts`, `mail_labels`, `mail_drafts` (+
`mail_drafts_attachments`), `mail_outbox`. These are local state Gmail cannot
give back.

**The sync tick had to change.** A restore now gives an account with no
sync-state row. The minute tick used to skip such an account silently (it only
bootstrapped when there were no accounts at all), and the banner shows nothing
in that state. Now the tick calls `ensureAccount()` for it, with the same
log-and-carry-on handling as first connect. Bootstrap arms a fresh watermark and
queues the backfill. The decision is a pure helper (`sync/server/internal/tick-plan.ts`)
with its own test.

**The foreign-key trap, and the check.** `pg_dump --exclude-table-data` keeps a
constraint's DDL, and `pg_restore` adds constraints after loading the data. So a
kept table with a foreign key to a left-out table makes the restore fail on the
first kept row that points across. `mail_drafts.thread_id` had exactly that
link (→ `mail_threads`, `ON DELETE SET NULL`). It is now a plain Gmail thread id
with no foreign key; resync brings the same id back.

To make the next one impossible to miss, the catalog read now also returns each
schema's foreign keys (top-level constraints only, self-references skipped), and
the shared table planner lists every kept → left-out link. Forks refuse with
`ForkPlanError` (non-retryable in the fork job); backups refuse with the new
`BackupPlanError`, before `pg_dump` runs. Left out → left out and left out →
kept are fine. A mail-core test checks mail's real declarations against its
drizzle schema.

**Expected saving:** about 846 MB on disk for the mail tables, on top of the
591 MB of `traces` — roughly 1.4 GB of main's database no longer copied into the
archive (compressed savings smaller; measure after the next run).

## Side note (not in scope)

The latest backup also dumps three leftover test databases
(`page_forest_test_*`). A killed test run left them behind, and the backup's
filter only skips `claude-*` and `att-*`. Worth a separate task.
