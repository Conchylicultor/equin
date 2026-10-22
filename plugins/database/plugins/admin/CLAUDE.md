# admin

## Fork exclusions — "don't fork my data"

A plugin opts **its own** table/schema out of the worktree DB fork, from its own
`contributions`. `reason` is required — an exclusion is invisible until someone
wonders why a table in their fork is empty.

- `ExcludeFromFork({ table, reason })` — this repo's own tables. Pass the drizzle
  table object (rename-safe, typo is a tsc error); a string only for tables made
  with `CREATE TABLE IF NOT EXISTS` instead of a migration.
- `ExcludeSchemaDataFromFork({ schema, keep, reason })` — schemas a foreign
  runtime creates for itself. `schema` is a glob; `keep` names the tables whose
  rows survive.

Both only ever empty tables. **There is no way to remove a schema**, and that is
the point: publications and event triggers are database-level objects `pg_dump`
emits regardless, so a missing schema dangles them (it once broke a restore on
seven statements), and a schema that is deleted needs an owner to put it back —
which has no spelling in a contribution. `graphile_worker` is what that cost: a
freshly-forked database could not accept a transactional enqueue until a backend
had booted against it.

`keep` is what makes deleting unnecessary. Graphile's migration watermark lives
in `graphile_worker.migrations`, inside the schema; keeping that one table hands
a fork a schema graphile already considers installed, while main's pending jobs
and crontab watermarks stay behind. `keep: []` is required rather than
optional — "nothing comes across" is the decision being asked for.

**Exclude derived state together with its sources.** Keeping `live_state_snapshot`
while emptying a table it read makes a fork serve a value that disagrees with the
rows behind it — for a boot-critical resource, that is what first paint renders.

## Every `pg_dump` argument is built from the source catalog

`pg_dump` silently accepts a pattern matching nothing, so a stale name or an
over-narrowed glob used to produce a fork that copied data nobody meant it to,
with no error anywhere. `internal/fork-plan.ts` matches the declarations against
the **source database's catalog** and builds each argument out of names that
were in it:

| declaration | emitted |
|---|---|
| `keep: []` | `"ext_0/log".*` per matched schema |
| `keep: ["migrations"]` | one quoted `schema.table` per non-kept relation |
| `ExcludeFromFork` | `public."traces"` plus every partition leaf under it |

Three details that each fix a real silent miss:

- **Quoting.** `pg_dump` parses a pattern with psql identifier rules, so an
  unquoted `ext_0.changeLog` case-folds to `changelog` and matches nothing.
- **The wildcard for `keep: []`.** The catalog is read before the fork takes its
  host-wide slot, and a service can create tables in main's database in that
  gap; deferring the relation set to dump time closes that window. The schema NAME is
  still catalog-derived, which is what the checks need.
- **Partition expansion.** `--exclude-table-data` does not cascade, and a
  partition's rows are dumped under the LEAF's name — so naming only the parent
  would exclude nothing. Nothing is partitioned yet; `traces` (949 MB) is the
  obvious first candidate and is already declared.

### Refused vs reported — split by who can cause it

`forkDatabase` resolves before creating its temp DB, so a refusal leaks nothing.

**Fatal** (`ForkPlanError` → the fork job re-raises it as `NonRetryableError`, so
it dead-letters after one attempt rather than five). Only an edit to THIS repo
can produce either:

- two declarations matching one schema — two `keep` lists, no honest merge;
- a `keep` entry naming no table — the rows you meant to preserve get emptied,
  which for `migrations` breaks graphile's boot in every fork;
- a kept table with a foreign key to a left-out table (read from the catalog,
  self-references and partition clones skipped) — `pg_restore` re-adds the
  constraint after the data, so a kept row pointing at a left-out row fails the
  restore. Leave the linking table out too, or make the link a plain id (as
  `mail_drafts.thread_id` is). Shared with backups via `planTableExclusions`.

**Reported, never fatal.** Everything the source database can cause on its own,
because the exclusion set comes from the forking checkout while the catalog comes
from *main's* database and those drift by construction:

- **a non-system schema no declaration claims** (and that holds data — a schema
  of functions and types has no rows to copy). This is what catches narrowing
  a family glob like `ext*` to `ext_*`. Fatal was the first draft and it was wrong: a branch cut
  before a plugin landed, a plugin deleted while its schemas live on in main's
  database, or one stray `CREATE SCHEMA` would each have become "no worktree can
  be created on this host". The fork job raises a bell notification deduped per
  schema; the CLI prints it.
- **a declaration matching nothing** — benign, and legitimate when a branch adds
  a table main has not migrated yet, or the service that creates a declared
  schema has never run on main.

`COPIED_SCHEMAS` (currently just `public`) is the explicit list of schemas whose
rows ARE app data. The rules are pure (`planForkExclusions`) and tested in
`internal/fork-plan.test.ts` with no database, because `admin` cannot import
`db-test-fixture` — the fixture imports `admin`.

Two more things that look wrong but are load-bearing:

- The contributions live in `admin`, not next to the fork job in `database/fork`,
  because `database/fork` imports `shell/notifications` — itself a declaring
  plugin — so hosting them there closes a cycle.
- `forkDatabase(source, target, exclusions)` takes the set as a **required
  parameter** instead of reading the registry. `getContributions()` answers `[]`
  in any process that never booted the server, so a registry read here would let
  `./singularity db fork` silently produce a full ~2 GB copy that looks fine.
  `forkExclusions()` throws on empty for the same reason; the CLI reads the set
  from a running backend over `GET /api/db/fork-exclusions`, which is why
  `ForkExclusions` is pure data and the flag-building lives in `fork-plan`.

## Connections and long statements

`getAdminPool()` (`admin`, the `postgres` maintenance database, one connection)
and `openShortLivedClient(db)` (`admin-short-lived`, a disposable one-connection
pool) are built by the connection plugin's `createDbPool`
(`plugins/database/plugins/connection/CLAUDE.md`). Opening a connection and every
statement on them give up after **60 s** with no reply.

Whole-database DDL legitimately takes longer, so it runs through
`runDatabaseDdl(what, sql)` (`server/internal/database-ddl.ts`), under
`DATABASE_DDL_QUERY_DEADLINE_MS` (10 min) with `what` as the reason on any
report:

| statement | where | why it can outlast a minute |
| --- | --- | --- |
| `DROP DATABASE … WITH (FORCE)` | `dropDatabase` (every sweep, reclaim and reset) | terminates the database's sessions, waits for them to exit, removes gigabytes of files |
| `CREATE DATABASE` | `ensureDatabase`, `forkDatabase`'s temp | copies the template database; waits on the database-object lock |
| `ALTER DATABASE … RENAME` | `forkDatabase`'s publish | waits on the database-object lock, e.g. behind a sweep dropping the same temp |

`runDatabaseDdl` checks a client out with `await pool.connect()` rather than
calling `pool.query`: pg-pool issues a queued `pool.query` from its checkout
callback, in the context of whoever released the connection, so the scope's
bound would be lost there.

Everything else stays on the 60 s default: catalog reads (`listDatabases`,
`databaseExists`, `databaseSizeBytes`, `countActiveConnections`, the fork and backup plans'
`readSchemaCatalog`, backup's table stats). `pg_dump` / `pg_restore` are
subprocesses, not pg connections, and are bounded by their own callers. They
are the vendored builds `pgClientBin` resolves
([`client-tools`](../client-tools/CLAUDE.md)), never a PATH lookup.

## Backup exclusions — "my rows can be left out of the backup"

`ExcludeFromBackup({ table, reason })` leaves a table's **rows** out of the
nightly `pg_dump` of every non-worktree database. The archive keeps its DDL, so
a restore gives an **empty table** — the owning plugin must treat empty as a
normal state (the chord trainer's song index reloads; `traces` just shows an
empty list).

It is a separate declaration from `ExcludeFromFork`, and neither implies the
other, because they answer different questions:

- fork: *does a fresh worktree need these rows?*
- backup: *does losing these rows cost anything?*

The answers differ often enough to matter: `mail_sync_state` stays in every
fork but is left out of backups, together with the Gmail corpus it watermarks.

`reason` must say one of two things: **the rows expire anyway** (`traces`, 7-day
evidence swept nightly), or **how they come back** (a cache rebuilt from a
snapshot file; the mail corpus refetched by sync). Anything a human authored,
or nothing can rebuild, does not qualify.

Mechanics mirror the fork, sharing `internal/catalog-plan.ts` (catalog read,
quoting, the table rule — must exist in `public`, partitions expanded to their
leaves):

- `backupDatabase(name, outFile, exclusions)` takes the set as a **required
  parameter**; `backupExclusions()` throws on an empty registry, for the same
  silent-full-copy reason as `forkExclusions()`.
- A declared table the database lacks is **reported, not fatal**
  (`BackupPlan.unmatched`, logged to the backup transcript): composition
  databases may never have had it.
- A kept table with a foreign key to a left-out one is **fatal**
  (`BackupPlanError`, thrown before `pg_dump`): the archive would dump fine and
  fail only on restore. Same rule and message as the fork's.
- `inspectBackup(file, name, plan.excludedTables)` marks those tables
  `rowsExcluded`. Row counts come from the live database, not the dump, so a
  manifest must not add their rows to what it claims was backed up.

Table-level only; the planner is `internal/backup-plan.ts`, tested without a
database in `backup-plan.test.ts`. The real dump → restore round trip is in
`backup/sources/databases` (`server/internal/backup-exclusion.test.ts`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Admin operations for the database plugin — fork, backup, drop, list.
- Server:
  - Uses:
    - `database/client-tools.pgClientBin`
    - `database/connection.createDbPool`
    - `database/connection.withQueryDeadline`
    - `infra/host/host-admission.defineHostPool`
  - DB schema: `plugins/database/plugins/admin/server/internal/table-label.ts`
  - Exports (types):
    - `BackupExclusions`
    - `BackupInfo`
    - `BackupPlan`
    - `ForkExclusions`
    - `ForkOutcome`
    - `ForkPlan`
    - `ForkSchemaExclusion`
    - `KeptForLink`
    - `TableStat`
    - `UndeclaredSchema`
  - Exports (values):
    - `backupDatabase`
    - `backupExclusions`
    - `BackupPlanError`
    - `closeAdminPool`
    - `connectionString`
    - `countActiveConnections`
    - `databaseExists`
    - `databaseSizeBytes`
    - `describeUndeclaredSchema`
    - `dropDatabase`
    - `ensureDatabase`
    - `ExcludeFromBackup`
    - `ExcludeFromFork`
    - `ExcludeSchemaDataFromFork`
    - `forkDatabase`
    - `forkExclusions`
    - `ForkPlanError`
    - `forkTempPrefix`
    - `getAdminPool`
    - `inspectBackup`
    - `isForkTempName`
    - `listDatabases`
    - `openShortLivedClient`
- Cross-plugin:
  - Imported by:
    - `apps/chord/song-index`
    - `apps/mail/mail-core`
    - `backup/sources/databases`
    - `build/serve-composition`
    - `database/db-test-fixture/sweep`
    - `database/fork`
    - `database/live-state-snapshot`
    - `database/query`
    - `debug/boot-profile`
    - `debug/latency-ledger`
    - `debug/slow-ops`
    - `debug/slow-ops/cluster`
    - `debug/timeline`
    - `debug/trace/engine`
    - `debug/worktree-cleanup`
    - `infra/claude-cli`
    - `infra/jobs/supervised-job`
    - `infra/launcher`
    - `infra/worktree/reclaim`
    - `reports/engine`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/backup.ts`, `server/internal/fork.ts`, `server/internal/pool.ts`, `server/internal/temp-name.ts` (debt)
- Test helpers:
  - Server: `@plugins/database/plugins/admin/server/testing`
    - `assertExclusionsClosed` — Check a plugin's `ExcludeFromBackup` / `ExcludeFromFork` declarations against its own drizzle tables, without a database: no kept table may have a foreign key to a table whose rows are left out (pg_restore would fail re-adding it).

<!-- AUTOGENERATED:END -->
