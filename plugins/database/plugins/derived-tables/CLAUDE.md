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
  the reconcile's write). Call it once.
- **A source** is a table whose writes move the rollup. `carry` is the source
  column naming the rollup row (the key, or — with `via: { table, match, key }`
  — a value one hop maps to it); `reads` are the other source columns the
  aggregate reads; `ops` narrows the statement kinds (default all three).
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
  calls `scope` once.
- **Asserted at install** (whenever a rollup's maintain functions are
  (re)installed): the `select`, compiled as a temp view, returns exactly the
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

## The boot install (`rebuildDerivedTables`)

Runs inside the migrations plugin's **one boot schema-layer transaction**
(`applySchemaLayer`, from the `database` plugin's `onReadyBlocking`), after the
migrations and `installDerivedUpdatedAt` and before `rebuildDerivedViews` (a view
may read a rollup). It takes `db` and `rollups` as arguments — never the database
barrel (a cycle) nor `DerivedTable.getContributions()` (empty in the
`migration-applies-clean` check, a process that never boots).

### Definition: only what changed

- **Table** — compared to its live shape (columns, types, nullability, key)
  every boot; created when missing, **dropped (CASCADE) and recreated** when it
  differs. A rollup is derived, so a shape change is a refill by the reconcile,
  never a migration; `rebuildDerivedViews` restores a view the CASCADE dropped.
- **Maintain functions** — `CREATE OR REPLACE`, no table lock, signature-gated
  per rollup (`functions:<rollup>` in `derived_table_object_state`), after the
  install-time `select` assert above.
- **Triggers — one source table per savepoint, in a fixed order (by name), only
  when that table's triggers changed** (C12 / D25; signature `triggers:<table>`
  plus the catalog: each trigger's name, function and shape — AFTER, FOR EACH
  STATEMENT, its one op, no column list — so a trigger altered by hand is
  reinstalled rather than left for A21 to refuse). A trigger change takes ShareRowExclusive on the source
  (`CREATE OR REPLACE TRIGGER`; only dropping a stale or legacy trigger takes
  AccessExclusive), held until the schema layer commits — savepoints release
  nothing. During a hot swap the old backend still writes those tables; the
  fixed order (attempts < conversations < pushes, the app's parent-before-child
  write order) means a writer in that order and the layer only ever wait for
  each other one way. A writer in the opposite order can close a cycle; Postgres
  aborts the layer, which fails loudly naming the table (`migrations/check/internal/rollup-boot-order.test.ts`).
  A steady-state boot takes no source lock at all.
- **Stale objects** — a trigger calling a managed maintain function that is not
  declared (a legacy hand-written `<rollup>_{i,u,d}`, a dropped source's) is
  dropped, then any unused managed function (`<rollup>_maintain`,
  `<rollup>__*_maintain`). Never a change-feed `live_state_*` or a
  `*_derive_updated_at` object.
- **A21** — every boot then asserts the catalog holds exactly the generated
  triggers: each on its source, calling its function, `AFTER … FOR EACH
  STATEMENT` on its one op, no column list.
- **State** — `derived_table_object_state`, one signature per object. The
  older builds' one-row `derived_table_state` (`id boolean, signature`) is kept
  in that shape and only **emptied** every boot: an older build booting on this
  database (main reverted past this layer, a branch on a fork of main) then
  finds no signature and reinstalls its legacy triggers beside these — harmless
  duplicates the next boot of this code drops as stale. Reshaping it would fail
  that build's `INSERT … ON CONFLICT (id)` and with it its whole schema layer;
  leaving its row would make it skip and run with no trigger at all. Drop the
  table once no supported build reads it.

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
`rebuildDerivedTables` → `{ table, upserted, deleted, definitionChanged }[]` →
`applySchemaLayer`'s `{ pending, rollups }` → the database plugin publishes them
with `publishReconciledRollups` **after the layer commits** (the dry run and the
replay suite compute heals that roll back). `reconciledRollups()` reads them and
throws before that commit. live-state-snapshot asserts it in `onReadyBlocking`
(A20) and treats a heal as its backstop: a healed rollup changed rows with
nothing in the changelog, so every persisted L2 row is cleared there — before
readiness flips, so boot-snapshot never serves one — and every persisted key
is recomputed in `onReady`.

## Consumers of the collection

- `feedExemptTables()` — the rollup table names; the change-feed merges them into
  its trigger denylist (a rollup is a read-cache fed by its sources' changes,
  never an independent write surface).
- `rollupSources()` — rollup → the source tables whose triggers maintain it
  (C30), for routing a rollup's readers by its sources' writes.
- `Rollup.sources` — query-resource's rollup join routes each source (`carry`,
  its `carryType`, `via`, `reads`, `pk`), never the rollup table (A1).

## Boundaries

- `core/` — `defineRollup` and the `Rollup` / `RollupSpec` / `RollupReconcile`
  types. Pure: drizzle handles in, SQL text out, no DB.
- `server/` — the `DerivedTable` contribution, `rebuildDerivedTables(db,
  rollups)`, `feedExemptTables()`, `rollupSources()`,
  `publishReconciledRollups` / `reconciledRollups()`.
- `server/testing` — `installRollups(db, rollups)`: the boot install, for a
  throwaway test database.
- The DB-backed oracles (`rollup-oracle.test.ts`, `rollup-boot-order.test.ts`)
  live in `migrations/check/internal/`, beside the schema-layer suites: this
  plugin is upstream of `database` (through migrations), so a suite here
  importing `db-test-fixture` (→ admin → database) would close an import cycle.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Trigger-maintained materialized rollup tables as data: defineRollup generates a rollup's table, a maintain function and triggers per source (diffing the columns it reads, advisory-locked per key) and a diff-first reconcile; the boot schema layer installs only what changed, one source table per savepoint, and reports what each reconcile healed (reconciledRollups). rollupSources() maps each rollup to the tables whose writes move it.
- Server:
  - Uses: `primitives/log-channels.defineLogSink`
  - Exports (values):
    - `DerivedTable`
    - `feedExemptTables`
    - `publishReconciledRollups`
    - `rebuildDerivedTables`
    - `reconciledRollups`
    - `rollupSources`
- Core:
  - Uses: `database/derived-views.assertImperativePublicTable`
  - Exports (types):
    - `CompiledRollupSource`
    - `Rollup`
    - `RollupColumn`
    - `RollupOp`
    - `RollupReconcile`
    - `RollupSourceSpec`
    - `RollupSpec`
    - `RollupTrigger`
    - `RollupVia`
  - Exports (values): `defineRollup`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shadow --shadow`
  - Imported by:
    - `conversations/agents`
    - `database`
    - `database/change-feed`
    - `database/live-state-snapshot`
    - `database/migrations`
    - `page/editor`
    - `tasks/tasks-core`
- Test helpers:
  - Server: `@plugins/database/plugins/derived-tables/server/testing`
    - `installRollups` — Install `rollups` onto a throwaway test database (`createTestDb`) whose source tables exist, and reconcile them — the SAME code path the boot schema layer runs (`rebuildDerivedTables`), so the DDL and the reconcile under test are byte-identical to what a backend installs.
    - `rollupSourcesOf` — `rollupSources` over an explicit rollup list (a headless suite has no contributions).

<!-- AUTOGENERATED:END -->
