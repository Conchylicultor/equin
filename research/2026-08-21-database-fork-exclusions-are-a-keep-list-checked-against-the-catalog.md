# Fork exclusions are a keep-list, checked against the catalog

## Context

`plugins/database/plugins/admin/server/internal/fork-exclusion.ts` is how a
plugin says "don't copy my data into a worktree DB fork". Two contributions
feed `forkDatabase`, which turns them into `pg_dump` flags:

| contribution | today | count |
|---|---|---|
| `ExcludeFromFork({ table, reason })` | `--exclude-table-data=public.<t>` | 12 |
| `ExcludeSchemaFromFork({ schema, reason, drop })` | `--exclude-schema` or `--exclude-table-data=<s>.*` | 2 |

Two defects, one in each half of that contract.

### 1. `drop: "schema"` deletes a schema and names no owner for putting it back

`--exclude-schema` removes a schema from the fork outright. The only answer to
"who recreates it" is prose in a `reason` string.

For `graphile_worker` that gap was load-bearing: a freshly-forked worktree
database was **born without a queue schema**, so a transactional enqueue
(`enqueue(input, { tx })`, the transport every task status-change takes) failed
with a bare Postgres `3F000` until a backend had booted against it. Four
tasks-core tests were red on exactly that, and the filed report mis-diagnosed it
as a test-fixture gap. It was fixed at the *enqueue* seam in 949997614 — an
installer plus an assert — while the declaration that creates the class was left
untouched.

`drop: "schema"` is also the arm that historically broke `pg_restore` on seven
statements for Zero: publications and event triggers are database-level objects
that `pg_dump` emits regardless, and each one naming a now-missing schema is a
restore error.

The reason jobs could not simply use the safer `drop: "data"` arm is that
graphile-worker records its own migration watermark in
`graphile_worker.migrations`, a table **inside** the schema being emptied. Empty
every table and graphile boots believing it is unmigrated, re-issues
`CREATE TABLE` against tables that already exist, and fails. The two-arm choice
cannot separate a schema's *shape* from its *contents*.

### 2. Nothing checks what the patterns match

`forkExclusions()` concatenates every declared pattern and hands them to
`pg_dump`, which **silently accepts a pattern that matches nothing**. Nothing
detects any of:

- two declarations matching the same schema (a `"schema"` and a `"data"`
  declaration on one schema silently voids the latter's intent);
- a declaration matching zero schemas (typo or stale name — the data is copied
  and nobody knows);
- a non-system schema matched by no declaration (copied wholesale, nobody
  decided).

Concrete: `zero*` matches `zero`, `zero_0`, `zero_0/cdc`, `zero_0/cvr` today.
Narrowing it to `zero_*` for apparent safety silently drops the bare `zero`
schema out of the exclusion set and copies it into every fork forever, with no
error anywhere. That mistake was actually made during the design discussion and
took a query against the live database to catch.

Globs cannot simply be banned: Zero mints app-id-keyed schemas at runtime, so
their names are not statically known.

### Intended outcome

1. No contribution can delete a schema. The dangerous arm has no spelling.
2. A forked worktree database is born with a working queue schema — the class of
   "born incomplete, healed later by whoever notices" is gone, not moved.
3. Every `pg_dump` pattern the fork emits is derived from a row in the source
   catalog, so "silently matches nothing" is impossible by construction.
4. A schema nobody decided about fails the fork loudly, naming itself and the
   fix.

## Design

### A. The declaration says what to KEEP; `drop` is deleted

```ts
export const ExcludeSchemaDataFromFork = defineServerContribution<{
  schema: string;                  // pattern — matched by US, never by pg_dump
  keep: readonly string[];         // exact table names whose ROWS survive
  reason: string;
}>("fork-schema-data-exclusion", { docLabel: (c) => c.schema });
```

DDL is **always** kept, rows are **always** dropped, except for the tables named
in `keep`. `keep` is required, not optional: `keep: []` is a positive statement
that nothing in the schema carries over, and that is the decision the author is
being asked to make.

- `graphile_worker` → `keep: ["migrations"]`. The watermark table survives, so
  the fork inherits a schema graphile already considers installed;
  `_private_jobs`, `_private_job_queues`, `_private_known_crontabs`,
  `_private_tasks` come over empty, so main's pending jobs and — the original
  motivation for `drop: "schema"` — main's `known_crontabs.last_execution`
  watermarks are not inherited.
- `zero*` → `keep: []`. Identical flags to today's `drop: "data"`.

`--exclude-schema` then has no user and `ForkExclusions.schemas` no longer
carries a mode. **Verified empirically** before committing to this (see
Verification 1): with `migrations` populated and every other graphile table
truncated, `installQueueSchema` is a no-op and a transactional enqueue lands a
row.

`installQueueSchema` at `onReadyBlocking` stays. It is no longer the thing that
makes a fork usable — it is what installs the schema on a database that never
had one (main's first boot, a `createTestDb` throwaway) and what applies new
graphile migrations after a version bump.

**The two contributions do not collapse into one**, even though both now compile
to `--exclude-table-data`. `ExcludeFromFork` takes a *drizzle table object*, so a
rename is refactor-safe and a typo is a tsc error; that is only possible for
tables this repo declares. `ExcludeSchemaDataFromFork` names *foreign* schemas
that a runtime creates for itself, which have no table object to pass and need a
pattern. Merging them would mean giving up the tsc-checked spelling for the 12
declarations that have it.

### B. Resolve against the source catalog; build every argument from it

New `plugins/database/plugins/admin/server/internal/fork-plan.ts`, in three
pieces so the interesting half is pure:

```ts
export async function readSchemaCatalog(source: string): Promise<SchemaCatalog>  // SQL
export function planForkExclusions(catalog: SchemaCatalog, e: ForkExclusions): ForkPlan  // pure
export async function resolveForkPlan(source: string, e: ForkExclusions): Promise<ForkPlan>
```

`readSchemaCatalog` opens a short-lived pool on the **source** database
(`openShortLivedClient`, already in `internal/pool.ts`) and reads every
non-system schema: its data-bearing relations (`relkind IN ('r','p','m')` —
materialized views included, since `--exclude-table-data` suppresses their
restore-time `REFRESH`), its partition trees, its size, and whether an extension
owns it.

`planForkExclusions` matches each declared pattern itself — a small glob
translated to a regex, the same `*`/`?` vocabulary authors already write — and
builds every `pg_dump` argument out of names that were in the catalog:

| declaration | emitted | why |
|---|---|---|
| `keep: []` | `"zero_0/cdc".*` per matched schema | the schema NAME is catalog-derived; the relation set is expanded by `pg_dump` at dump time |
| `keep: [...]` | `"graphile_worker"."_private_jobs"`, … | `pg_dump` has no "all but these", so the keep-list arm must enumerate |
| `ExcludeFromFork` | `public."traces"` + every partition leaf | a partition's rows are dumped under the LEAF's name, and `--exclude-table-data` does not cascade |

The wildcard for `keep: []` is not a shortcut. The catalog is read *before* the
fork acquires its host-wide slot, and main runs a live zero-cache that mints
schemas and tables on its own schedule — so an enumerated list could be stale by
the time `pg_dump` runs, and the new table would be copied in full without even
appearing as an unmatched declaration. Deferring the relation set to dump time
closes that window for the only schema family it is real for. `graphile_worker`
keeps the enumerated form because it must, and its table set changes only when
graphile migrates.

Quoting is not cosmetic. Zero's table names are mixed-case (`changeLog`,
`publishedSchema`, `rowsVersion`) and its schema names contain `/`
(`zero_0/cdc`); `pg_dump` parses a pattern with psql identifier rules, so an
unquoted `zero_0.changeLog` case-folds and matches nothing.

**This is the structural fix for defect 2.** No author-written pattern reaches
`pg_dump` any more, so the question "did this pattern match anything?" is one we
ask and answer, rather than one `pg_dump` silently swallows.

`forkDatabase(source, target, exclusions, signal)` calls `resolveForkPlan`
itself, after the idempotent `databaseExists` early return and **before** the
temp database is created — so a refusal leaks no temp. It returns a
discriminated `ForkOutcome` (`already-present` | `forked` + plan) so both
callers can surface what the plan found. `ForkExclusions` stays pure data, so it
still crosses HTTP for the CLI path.

### C. What the plan refuses, and what it reports

The split is by **who can cause it**, not by how bad it looks.

**Fatal** (`ForkPlanError`, re-raised by the fork job as `NonRetryableError` so
it dead-letters after one attempt instead of five) — the two states only an edit
to *this repo* can produce:

- **Two declarations matching one schema.** They carry two `keep` lists and
  merging them silently voids one.
- **A `keep` entry matching no table in any schema its declaration matched.** The
  rows meant to be preserved get emptied — for `migrations` that means every
  fork is born with a queue schema graphile believes is unmigrated, which breaks
  its boot. Refusing is strictly better and far more legible.

**Reported, never fatal** — everything caused by the source database and the
forking checkout drifting apart, which they do by construction:

- **A non-system schema no declaration claims** (and that actually holds
  data-bearing relations — a schema of functions and types has no rows to copy).
  This is the case that catches narrowing `zero*` to `zero_*`. It was fatal in
  the first draft of this design, and that was wrong: the exclusion set comes
  from the forking checkout's contributions while the catalog comes from *main's*
  database, so a branch cut before a plugin landed, a plugin deleted while its
  schemas live on in main's database forever, or one stray `CREATE SCHEMA` from a
  debugging session would each have become "no worktree can be created on this
  host" — strictly worse than copying the rows it was trying to save. The fork
  proceeds and says so: `database/fork`'s job raises a bell notification deduped
  per schema (so it appears once, not once per worktree), and the CLI prints it.
- **A declaration matching nothing.** Benign — there is no data to copy, so the
  intent already holds — and legitimate: a branch that adds a table plus its
  exclusion forks from a main that has not migrated yet, and `zero*` matches
  nothing where zero-cache has never run.

`COPIED_SCHEMAS = ["public"]` is the explicit spelling of the one schema whose
rows are the app's own (individual tables inside it opt out via
`ExcludeFromFork`). System schemas — `pg_*`, `information_schema`, and any
schema owned by an extension (`pg_extension.extnamespace`) — are never reported:
an extension's schema arrives with `CREATE EXTENSION` and its contents are the
extension's, not the app's.

### D. Loose ends folded in

- `fork-exclusion.ts` and `fork.ts` cite "~970 MB down to ~35 MB" with traces at
  722 MB. Measured today: **2057 MB → 34 MB**, with `traces` at 949 MB and
  `mail_messages` at 781 MB (the mail corpus was not yet excluded when those
  numbers were written).
- `research/2026-08-20-jobs-queue-schema-is-a-property-of-the-database.md`
  § "Not doing now" describes a `reinstall(connectionString)` callback that
  `forkDatabase` would run against the temp database. This design supersedes it:
  a fork that keeps the watermark has nothing to reinstall, and the callback
  could not have crossed the HTTP wire anyway. That section is rewritten to point
  here.
- `QueueSchemaMissingError`'s message tells the reader the schema is
  "deliberately excluded from the worktree DB fork". That stops being true;
  it is reworded to name what a database with no queue schema actually is (one
  that never hosted a booted backend — a throwaway test database).

## Files

- `plugins/database/plugins/admin/server/internal/fork-exclusion.ts` — rename
  the contribution, drop `drop`, add `keep`, reshape `ForkExclusions`.
- `plugins/database/plugins/admin/server/internal/fork-plan.ts` (new) + `.test.ts`
  (new, pure — no database, so no `db-test-fixture` edge out of `admin`).
- `plugins/database/plugins/admin/server/internal/fork.ts` — resolve, warn,
  emit resolved flags, return `ForkOutcome`; `--exclude-schema` deleted.
- `plugins/database/plugins/admin/server/internal/pool.ts` — an idle-client
  `error` on a short-lived pool must not kill the backend (the same handler
  `fork-schema-drift.ts` already installs on its own disposable pool).
- `plugins/database/plugins/fork/server/internal/fork-job.ts` — bell
  notification per unclaimed schema; `ForkPlanError` → `NonRetryableError`.
- `plugins/database/plugins/admin/server/index.ts`, `CLAUDE.md`.
- `plugins/database/plugins/fork/core/endpoints.ts`,
  `.../server/internal/handle-exclusions.ts`,
  `plugins/framework/plugins/cli/plugins/db/cli/fork.ts` — the wire shape.
- `plugins/infra/plugins/jobs/server/index.ts` + `internal/queue-schema.ts`
  (+ `.test.ts`) — the `graphile_worker` declaration and its prose.
- `plugins/database/plugins/zero/plugins/cache-service/server/index.ts` — `keep: []`.

## Verification

All of the following was run against this branch.

1. **`./equin test plugins/infra/plugins/jobs`** — the fork-shaped-schema
   case: seed a throwaway database, truncate every graphile table except
   `migrations` (exactly what the new flags produce), re-run
   `installQueueSchema`, and land a transactional enqueue whose row is the only
   one in the queue. ✅
2. **`./equin test plugins/database/plugins/admin`** — `planForkExclusions`
   against main's real catalog: both fatal rules throw, the unclaimed schema and
   the unmatched declaration are reported without throwing, a partitioned table
   expands to its leaves, and the emitted arguments are exactly the quoted
   names. ✅
3. **`./equin check` + `./equin build`** — boundaries (no new plugin
   edge out of `admin`), `type-check`, `plugins-doc-in-sync`; deployed. ✅
4. **A real fork** — `./equin db fork`, main's 2057 MB database, twice.

   | | main | fork |
   |---|---|---|
   | size | 2057 MB | **35 MB** |
   | `graphile_worker.migrations` | 18 | **18 — kept** |
   | `_private_jobs` / `_known_crontabs` / `_tasks` / `_job_queues` | 0 / 38 / 5 / 2 | **0 / 0 / 0 / 0** |
   | graphile functions + `jobs` view | 7 + 1 | **7 + 1** |
   | publications / event triggers | 2 / 2 | **2 / 2** |
   | `traces` / `mail_messages` / `notifications` | 1.1M+ | **0 / 0 / 0** |
   | `tasks` / `conversations` | 4287 / 4204 | **4287 / 4204** |

   No unmatched declarations, no unclaimed schemas. Both probe databases were
   dropped afterwards through `dropDatabase`.

### What the first real fork caught, and what it cost

Run 1 produced a correct-looking 35 MB fork whose `graphile_worker` rows had
**all** come across. The cause was one layer below this design:
`array_agg(relname)` produces `name[]`, and `pg` has no decoder for that OID, so
`tables` arrived as the raw literal string `"{_private_jobs,migrations,…}"`.
The planner iterated it one character at a time and emitted
`"graphile_worker"."_"`, `…"."p"`, … — sixty patterns that matched nothing, which
`pg_dump` accepted in silence. The keep-list check passed too, because
`"{…migrations…}".includes("migrations")` is `true` on a string.

That is precisely the class of silent miss this design exists to remove,
reintroduced one layer down — and neither the pure test suite (which builds a
well-formed catalog by hand) nor any check could see it. The fix is `::text`
casts plus a `CatalogRowSchema` **parse** rather than `pool.query<T>`'s
assertion, so a shape that is not an array is now a loud failure at the boundary
instead of a fork that looks like it worked. `array_agg` over a `pg_catalog`
`name` column appears nowhere else in the repo.
