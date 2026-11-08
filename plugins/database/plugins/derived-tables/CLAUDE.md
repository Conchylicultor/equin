# derived-tables

A **trigger-maintained materialized rollup** ("hand-rolled IVM") is the home for
an aggregate that is too expensive to recompute from scratch on every live-state
load, yet **not expressible as a plain derived view** (a "latest row per group",
a per-parent aggregate a hot view joins). It is the L3/IVM rung of the
live-state engine, built without the unavailable `pg_ivm` extension.

Like a plain derived view, a rollup is **derived state, not stateful schema**:
fully recomputable from its source tables, created imperatively on boot (never a
drizzle migration), kept current by STATEMENT-level triggers on its sources, and
diffed against them on every boot.

## A rollup is data: `defineRollup`

```ts
export const attemptConvAgg = defineRollup({
  table: _attemptConvAgg,            // drizzle READ handle (non-glob file)
  key: _attemptConvAgg.attemptId,    // its single-column primary key
  select: (scope) => `SELECT c.attempt_id, true AS has_conv, …
                        FROM conversations c WHERE ${scope("c.attempt_id")}
                       GROUP BY c.attempt_id`,
  sources: [{ table: _conversations, carry: _conversations.attemptId,
              reads: [_conversations.status, _conversations.endedAt] }],
});
// server definition: contributions: [DerivedTable(attemptConvAgg)]
```

- **The minted `Rollup<T>` carries its handle** (`rollup.handle`, the
  `table` passed in): a collection joining the rollup (query-resource's
  `RollupJoin`) reads its table from there, so the table read and the sources
  routed are one rollup's by construction.
- **`select`** returns the rollup's rows, exactly its columns by name;
  `scope(keyExpr)` restricts them to the keys being maintained (`true` in the
  reconcile's drift scan, `keyExpr = ANY(<keys>)` in a maintain function and
  the reconcile's write). Call it at least once (a recursive select scopes
  each place it seeds from).
- **A source** is a table whose writes move the rollup. `carry` is the source
  column naming the rollup row (the key, or — with `via: { table, match, key }`
  — a value one hop maps to it); `reads` are the other source columns the
  aggregate reads; `ops` narrows the statement kinds (default all three).
- **`closure: { edges, child, parent }`** — a rollup over a TRANSITIVE
  relation (a key's row reads its ancestors' rows over `edges`). Every
  maintain function expands the keys it resolved to their transitive
  dependents before aggregating: walk, lock the whole set (sorted), walk again
  in a fresh statement, and repeat only if that walk found a key not yet
  locked (an edge committed between the two walks). The edge table must be a
  source carrying `child`; an edge write also locks (never re-aggregates) its
  `parent`, so a concurrent write of that parent's facts either commits first
  or sees the edge. Only a repeated pass locks out of sorted order, so two
  writers racing on one edge can abort with a loud 40P01 — never a stale row.
- **`fed: true`** — the rollup table is ON the change feed: readers are
  routed by its own rows, not its sources (not in `feedExemptTables()` nor
  `rollupSources()`). The guarded upsert means a reader hears of a key exactly
  when its value changed, even through a closure no source route can follow.
  What query-resource's `materializeJoin` declares.
- **A source may be another rollup's table** (a rollup ON a rollup): its
  trigger fires on the inner rollup's own writes, i.e. only when that
  aggregate changed, and after it did. The reconcile runs such a reader after
  the rollups it reads (`readersLast`); a cycle is refused.
- **Everything is generated** (`core/internal/define-rollup.ts`): the
  `CREATE TABLE` from the handle's columns; per source one
  `<rollup>__<source>_maintain()` function and its
  `<rollup>__<source>_{i,u,d}` triggers; the reconcile. So the triggers, the
  columns an UPDATE diffs and the source list routing reads (`rollupSources()`)
  cannot disagree.
- **Asserted at module eval:** the table is an `IMPERATIVE_PUBLIC_TABLES` value
  (`assertImperativePublicTable`, C11 — the generated `CREATE TABLE` line carries
  that call, which is how `imperative-create-table-allowlisted` accepts it); `key`
  is the table's only pk column; every column belongs to the table it is used
  against; a carry (or via hop) has the key's type; one source per table; `select`
  calls `scope`; a closure's columns have the key's type and its edge table is a
  source carrying `child`.
- **Asserted at install** (whenever a rollup's trigger set has anything to
  (re)install, before its DDL): the `select`, compiled as a temp view, returns exactly the
  table's columns (the projection reads them by name, so an extra one would be
  dropped silently), and every column it reads is declared — on a source table
  its pk, `carry` or a `reads` entry, on a via table `match` or `key`; any other
  table is refused. Read off the view's `pg_depend` rows, i.e. what Postgres
  parsed. An undeclared read is a write no UPDATE re-aggregates (C1), which
  would leave the rollup stale until the next boot's reconcile. A whole-row
  reference (`row_to_json(c)`) records no column and is not seen.

### What a maintain function does

1. **Collect the carried values the statement moved.** INSERT: `new_rows`;
   DELETE: `old_rows`; UPDATE: `old_rows FULL JOIN new_rows ON <pk>` where the pk
   changed or `ROW(carry, reads…)` IS DISTINCT. The UPDATE trigger has **no
   column list** (C1): Postgres refuses transition tables on one, so the diff
   lives here — a write to a column the rollup does not read (`waiting_for`,
   `last_viewed_at`, …) re-aggregates nothing.
2. **Resolve them to keys** (through `via` if declared), sorted.
3. **A34: take a transaction-scoped advisory lock per key, in sorted order,**
   before aggregating. A concurrent writer of the same key waits until this
   transaction ends, and its own aggregate — a fresh statement — then sees this
   one's rows. Without it two writers each aggregate without the other's rows
   and the later upsert loses one (`migrations/check/internal/rollup-oracle.test.ts` pins it).
   Locks of two rollups taken by one RI cascade cannot be globally ordered, so a
   cross-rollup abort stays possible; it is a loud 40P01, never silent.
4. **Upsert the aggregate guarded** (`DO UPDATE … WHERE ROW(t.vals) IS DISTINCT
   FROM ROW(EXCLUDED.vals)`), so an unchanged row keeps its xmin, and **delete**
   a key the aggregate no longer has.

**A hop is read at trigger time.** An RI cascade that deletes the hop row (an
attempt delete cascading to its conversations) resolves nothing through it; the
hop table must then be a source of its own whose `carry` is the key
(`task_latest_conversation`'s `attempts` source, carrying `task_id` on update and
delete — step 21 of `research/2026-10-06-global-scoped-change-routing-p8-v3.md`;
before it, only the boot reconcile healed that case). A collection that JOINS such a rollup is refused
at module eval until it does: query-resource's A35 (`assertHopsCovered`)
requires each `via` table to be a source of the same rollup carrying the hop's
`key`, reading its `match`, firing on `update` and `delete` — without it the
reader's route would miss the old key exactly as the maintain function does.

## The boot install

Three steps inside the migrations plugin's **one boot schema-layer
transaction** (`applySchemaLayer`, from the `database` plugin's
`onReadyBlocking`), after the migrations and before `rebuildDerivedViews` (a
view may read a rollup). Each takes `db` and `rollups` as arguments — never the
database barrel (a cycle) nor `DerivedTable.getContributions()` (empty in the
`migration-applies-clean` check, a process that never boots).
`installRollups(db, rollups)` (`server/testing`) is the same three steps over
the rollups alone, for a test database.

### Definition: only what changed

- **Table** (`prepareRollupTables`, which also hands back each rollup's trigger
  set) — compared to its live shape (columns,
  types, nullability, key) every boot; created when missing, **dropped
  (CASCADE) and recreated** when it differs. A rollup is derived, so a shape
  change is a refill by the reconcile, never a migration; `rebuildDerivedViews`
  restores a view the CASCADE dropped.
- **Maintain functions and source triggers** — one db-triggers set per rollup
  (`rollup.<table>`), installed by the ONE trigger
  installer (`database/db-triggers`) in the schema layer's single call that
  holds every declared trigger set. What that gives a rollup (see that
  plugin's `CLAUDE.md`): per-object stamps checked against the catalog
  definition, so a function or trigger dropped, altered or replaced out of band
  (an older build's maintain function on a fork) is reinstalled, and a changed
  function body re-runs only the function (no table lock); every source table
  locked in the installer's one fixed order, one savepoint each, only when its
  triggers changed (C12 / D25 — a steady-state boot takes no source lock); a
  stray trigger calling a maintain function, or a removed source's trigger and
  function, dropped; a removed rollup's whole set swept at boot (its TABLE is
  left — the previous backend still reads it during a hot swap — for the
  `orphaned-db-tables` check). The installer asserts every set current after.
- **Asserted before the DDL** (`beforeInstall`): the `select` against its
  declaration (above), whenever the rollup's set has anything to (re)install.
- **Older builds' state tables** — `derived_table_state` (one row) and
  `derived_table_object_state` (per object) are no longer read; both are kept
  in their shape and only **emptied** every boot. An older build booting on
  this database (main reverted past this layer, a branch on a fork of main)
  then finds no signature and reinstalls its own functions and triggers — the
  next boot of this code sees their catalog definitions differ from its stamps
  and reinstalls its own. Left holding rows, it would trust them and skip.
  The per-object one is READ before it is emptied: a `triggers:<table>` row
  equal to the signature the previous installer computed for this build's
  triggers on that table marks them adoptable (`legacyStamp: null`), so the
  first boot of the one installer restamps them instead of locking every
  source table. Drop both tables, and that read, once no supported build reads
  them.

### Repair: the reconcile, every boot, diff-first (D21)

A rollup holds rows and can drift with its definition byte-identical (a
`TRUNCATE` fires no trigger; a source write the declaration missed; downtime and
bulk loads), so no definition signature can license skipping it. Per rollup, in
one transaction (a savepoint of the schema layer):

1. **`driftSql`** — read-only: the keys whose row differs from the aggregate,
   is missing, or has no aggregate. A clean boot stops here — it writes and
   locks nothing (before, it rewrote every row every boot).
2. **`lockSql(keys)`** — the maintain functions' A34 advisory lock per key, in
   the same sorted order, held until the schema layer commits.
3. **`reconcileSql(keys)`** — the maintain functions' own write over those
   keys, in a fresh statement (a fresh snapshot): re-aggregate, upsert only
   what differs, delete what has no aggregate; returns the counts.

The lock is what makes a heal safe against the old backend writing during a
hot swap: a maintain holding a key's lock commits before step 3 aggregates (so
step 3 sees its rows), and one arriving later waits for the layer and then
aggregates over the healed state. Without it, a maintain that found the drifted
row already equal to its new aggregate would write nothing, and the reconcile
would overwrite the row from a snapshot predating that write
(`rollup-oracle.test.ts` pins it). Its locks across rollups are taken rollup by
rollup (by table name); a writer holding another order can close a cycle, which
Postgres aborts loudly (40P01) — and only on keys that had drifted.

**It returns its counts, it does not publish them (C13):**
`reconcileRollups` → `{ table, upserted, deleted, definitionChanged }[]` →
`applySchemaLayer`'s `{ pending, rollups }` → the database plugin publishes them
with `publishReconciledRollups` **after the layer commits** (the dry run and the
replay suite compute heals that roll back). `reconciledRollups()` reads them and
throws before that commit. live-state-snapshot asserts it in `onReadyBlocking`
(A20) and treats a heal as its backstop: a healed rollup changed rows with
nothing in the changelog, so every persisted L2 row is cleared there — before
readiness flips, so boot-snapshot never serves one — and every persisted key
is recomputed in `onReady`.

## Consumers of the collection

- `feedExemptTables()` — the rollup table names (every rollup but a `fed`
  one); the change-feed merges them into its trigger denylist (a rollup is a
  read-cache fed by its sources' changes, never an independent write surface).
- `rollupSources()` — rollup → the source tables whose triggers maintain it
  (C30), for routing a rollup's readers by its sources' writes. A `fed`
  rollup is not in it: it is its own change source.
- `Rollup.sources` — query-resource's rollup join routes each source (`carry`,
  its `carryType`, `via`, `reads`, `pk`), never the rollup table (A1).

## Boundaries

- `core/` — `defineRollup` and the `Rollup` / `RollupSpec` / `RollupReconcile`
  types. Pure: drizzle handles in, SQL text out, no DB.
- `server/` — the `DerivedTable` contribution, the boot install's steps
  (`prepareRollupTables`, `reconcileRollups`), `feedExemptTables()`,
  `rollupSources()`,
  `publishReconciledRollups` / `reconciledRollups()`.
- `server/testing` — `installRollups(db, rollups)`: the boot install's three
  steps over the rollups alone, for a throwaway test database.
- The DB-backed oracles (`rollup-oracle.test.ts`, `rollup-boot-order.test.ts`)
  live in `migrations/check/internal/`, beside the schema-layer suites: this
  plugin is upstream of `database` (through migrations), so a suite here
  importing `db-test-fixture` (→ admin → database) would close an import cycle.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Trigger-maintained materialized rollup tables as data: defineRollup generates a rollup's table, a maintain function and triggers per source (diffing the columns it reads, advisory-locked per key) and a diff-first reconcile; each rollup's functions and triggers a db-triggers set (rollup.<table>) the one trigger installer installs; the boot schema layer prepares the tables, installs every trigger set at once, reconciles, and reports what each reconcile healed (reconciledRollups). rollupSources() maps each rollup to the tables whose writes move it.
- Server:
  - Uses:
    - `database/db-triggers.DbTriggerInstall`
    - `database/db-triggers.DbTriggerSet`
    - `database/db-triggers.defineDbTriggers`
    - `database/db-triggers.installDbTriggers`
    - `primitives/log-channels.defineLogSink`
  - Exports (types): `PreparedRollups`
  - Exports (values):
    - `DerivedTable`
    - `feedExemptTables`
    - `prepareRollupTables`
    - `publishReconciledRollups`
    - `reconciledRollups`
    - `reconcileRollups`
    - `rollupSources`
- Core:
  - Uses: `database/derived-views.assertImperativePublicTable`
  - Exports (types):
    - `CompiledRollupSource`
    - `Rollup`
    - `RollupClosure`
    - `RollupColumn`
    - `RollupOp`
    - `RollupReconcile`
    - `RollupSourceSpec`
    - `RollupSpec`
    - `RollupTrigger`
    - `RollupVia`
  - Exports (values): `defineRollup`
- Cross-plugin:
  - Imported by:
    - `conversations/agents`
    - `database`
    - `database/migrations`
    - `network/live/change-feed`
    - `network/live/live-state-snapshot`
    - `network/live/query-resource`
    - `page/editor`
    - `page/links`
    - `tasks/tasks-core`
- Exemptions:
  - Exempts itself from: `sql-writes:fit:dynamic` — `core/internal/define-rollup.ts`, `server/internal/rebuild.ts` (sanctioned)
- Test helpers:
  - Server: `@plugins/database/plugins/derived-tables/server/testing`
    - `installRollups` — Install `rollups` onto a throwaway test database (`createTestDb`) whose source tables exist, and reconcile them — the SAME code path the boot schema layer runs (prepare the tables, install the trigger sets, reconcile), so the DDL and the reconcile under test are byte-identical to what a backend installs.
    - `rollupSourcesOf` — `rollupSources` over an explicit rollup list (a headless suite has no contributions).

<!-- AUTOGENERATED:END -->
