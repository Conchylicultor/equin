# Backup: plan exclusions per database, and back up only real databases

## Context

Every nightly backup since 2026-09-19 has had a failed **Databases** source. On 2026-09-23 4 of 7 databases were left out of the archive:

| database | why it was dumped at all | why it failed |
|---|---|---|
| `sonata` | composition app, marker `~/.singularity/worktrees/sonata/composition.json` (checkout `null`) | last migrated 2026-08-24, so it still has `mail_drafts → mail_threads` FK (dropped on main 2026-09-17, a85f17fab1) |
| `website` | no namespace dir on disk — an orphan | same stale FK |
| `sonata.att-1787097707-cveo` | no namespace dir — orphan composition-worktree DB | same stale FK |
| `page_forest_test_60438_mtutbt9f` | legacy test DB, minted before the `__testdb` suffix existed (2026-09-10), so the sweep never sees it | same stale FK |

Cause: `planBackupExclusions` (`plugins/database/plugins/admin/server/internal/backup-plan.ts`) applies **today's** declared `ExcludeFromBackup` set to every database. It refuses a database whose kept table links to an excluded one. The refusal is right for the schema this checkout declares. It is wrong for a database created by an older version of the schema, which the current code cannot migrate from the backup job.

Two fixes, both agreed with the user:

1. **Per-database planning.** Leaving rows out only saves space; it is never needed for correctness. So for a database that still links into an excluded table, keep that table's rows and say so in the manifest. The refusal stays strict for the database whose schema *is* the current one.
2. **Back up only real databases.** Choose databases by what they are (main app, or a composition app's own database), not by excluding name prefixes. Everything else is skipped. Orphans are **named** on the run card; they don't make the run partial (user's choice).

## Design

### 1. Per-database exclusion plan (`database/admin`)

`backup-plan.ts`:

- `planBackupExclusions(catalog, exclusions, { strict })` returns
  `BackupPlan & { keptForLinks: KeptForLink[] }` where
  `KeptForLink = { table: string; linkedFrom: string; constraint: string }`.
- Algorithm: fixpoint over **declared** table names (not partition leaves):
  1. `excluded = declared ∩ catalog tables`.
  2. Run `planTableExclusions(catalog, excluded)`. If `keptLinks` is empty, stop.
  3. Otherwise, if `strict`, throw `BackupPlanError` as today. Else take every
     `keptLinks[i].references` out of `excluded`, record a `KeptForLink` for each, and repeat.
  - Terminates: `excluded` shrinks every round. Needed because keeping table X's rows can
    make X's own FK into another excluded table a new kept → left-out link.
  - Partition leaves follow automatically: `planTableExclusions` expands leaves from the
    declared names it is given.
  - An FK may name a partition leaf rather than its parent (see the `log_readers → log_2026_09`
    test). Map a leaf back to its declared parent before removing it from `excluded`
    (`appSchema.partitions` gives parent → leaves).
- `resolveBackupPlan(source, exclusions, { strict })` passes it through. It keeps the
  database name in the error.
- `backupDatabase(name, outFile, exclusions, { strict })` logs one
  `[db-backup] <name>: kept rows of <t> — <linkedFrom> still links to it (<constraint>)`
  line per entry, next to the existing `unmatched` warnings.
- `strict` is **required**, not defaulted, so every caller has to decide.
- The fork planner (`fork-plan.ts`) is **unchanged**. A fork's source is always main, and main's schema is current.

Who is strict: `assembleDatabases` passes `strict: true` for the database of the
namespace the backup runs in, and `false` for the others. The backup runs in main (`singularity`), whose
migrations run on boot, so its schema is the code's schema. Get the running
namespace from `runtime-identity` (`readNamespaceArgv` / its server reader). **Verify during
implementation** that the supervised-exec backup child declares `--namespace`. If it
doesn't, take the namespace the backup run row already records (`backup_runs.namespace`) and pass it down.

The current-schema guard stays where it already is: `planBackupExclusions` itself, in strict mode,
used by `mail-core/.../data-exclusions.test.ts` (update those calls to `{ strict: true }`).

### 2. Database selection (`backup/sources/databases`)

New pure classifier in the databases source (`server/internal/select-databases.ts`):

```ts
type DbKind =
  | { kind: "main" }                       // MAIN_WORKTREE_NAME
  | { kind: "composition"; id: string }    // marker exists, checkout === null
  | { kind: "worktree" }                   // namespace with a checkout part (att-…, <comp>.att-…)
  | { kind: "test" }                       // parseTestDbName(name) !== null
  | { kind: "fork-temp" }                  // admin's `__forking` temp grammar
  | { kind: "orphan" };                    // none of the above
classifyDatabase(name, marker: CompositionMarker | null): DbKind
```

- Back up only `main` and `composition`. The marker is read with `readCompositionMarker`
  (`@plugins/infra/plugins/worktree/server`), and the name is split with `namespaceParts` / `isNamespace`
  (`@plugins/infra/plugins/namespace/core`).
- **A worktree is recognised from the name's structure**, not from the `att-` prefix. Recheck what
  `claude-*` databases are while implementing: they should land in `worktree` or `orphan`, never in a new
  hard-coded prefix.
- `test`: `parseTestDbName` from `@plugins/database/plugins/db-test-fixture/core`. Legacy
  test DBs without the suffix come out as `orphan`, and are named on the card (that is the
  `page_forest_test_*` case).
- `fork-temp`: export admin's existing temp-name parser from the admin barrel if it isn't exported already
  (`admin/server/internal/temp-name.ts`), rather than re-spelling the regex.
- `assembleDatabases` replaces the `att-`/`claude-` filter with the classifier.
  - Skipped worktree / test / fork-temp databases are counted in one item:
    `"not backed up: 212 worktree, 3 test databases"`.
  - Each orphan is its own item, by name: `"website — not backed up: no app owns this database"`.
    This does not change the source's `outcome`.
- Each backed-up database item also says when rows were kept for links, e.g.
  `"… (rows of mail_threads kept: mail_drafts still links to it)"`, alongside the existing
  "rows of N tables left out" text (`describeDump`). `inspectBackup` already gets
  `plan.excludedTables`, so the kept table is counted as backed up.

### Resulting behaviour on today's cluster

- `singularity`: strict, backed up as now.
- `sonata`: backed up, `mail_threads` rows kept, and the manifest says why.
- `website`, `sonata.att-1787097707-cveo`, `page_forest_test_*` (×3): skipped, each named.
- The source ends `included`, so the run is `ok` once the Drive consent is fixed (a separate problem).

## Files

- `plugins/database/plugins/admin/server/internal/backup-plan.ts` — strict flag, fixpoint, `keptForLinks`.
- `plugins/database/plugins/admin/server/internal/backup.ts` — thread `strict`, log kept rows.
- `plugins/database/plugins/admin/server/index.ts` — export `KeptForLink` type and the fork-temp parser if needed.
- `plugins/backup/plugins/sources/plugins/databases/server/internal/assemble-databases.ts` — classifier, strictness, manifest items.
- `plugins/backup/plugins/sources/plugins/databases/server/internal/select-databases.ts` (new) + test.
- `plugins/apps/plugins/mail/plugins/mail-core/server/internal/data-exclusions.test.ts` — `{ strict: true }`.
- Update comments that describe the old refusal: `backup-exclusion.ts` header, the `allSettled` comment in `assemble-databases.ts`, the `resolveBackupPlan` doc.

## Verification

- `./equin test plugins/database/plugins/admin` — new `backup-plan.test.ts` cases:
  - lenient keeps the linked table and reports it;
  - the chain case (A kept → B excluded, B → C excluded ⇒ both B and C kept);
  - FK to a partition leaf keeps the parent and all its leaves;
  - strict still throws `BackupPlanError`;
  - no links ⇒ `keptForLinks` is empty.
- `./equin test plugins/backup/plugins/sources/plugins/databases` — classifier table test: `singularity`,
  `sonata`+marker, `sonata` without marker, `att-…`, `sonata.att-…`, `x__testdb`, legacy
  `page_forest_test_1_abc`, a fork temp name.
- `./equin test plugins/apps/plugins/mail`.
- `./equin build`, then run a backup from the Backup app on this worktree and check the run card:
  every expected database is included, orphans are named, and there is no failed source. `query_db` on
  `backup_runs.manifest` confirms it.
