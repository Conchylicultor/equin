# Slow Ops as a live, paged collection — v2: callers in their own table, the other rings merged in SQL

Supersedes the write-side and detail parts of [v1](./2026-10-13-debug-slow-ops-live-collection.md). Everything v1 says that this doc does not change still holds: the list collection, the pane, the produced table's churn analysis, the docs to update and the verification. Those parts are summarised here, not repeated.

## Context

Debug → Slow Events → Aggregates reads `slow-ops.list`, an external snapshot value. Each read is `SELECT * FROM slow_ops ORDER BY total_ms DESC` with no limit (about 21 MB, never live). The cause is the write shape in `record-slow-op.ts` (`upsertSlowOpIn`):
- each occurrence upserts the counters, reads the row back, merges five JSON lists in JS, and rewrites the row, all in one transaction;
- the table is therefore `ExcludeFromChangeFeed` (it was the largest source of churn), and it cannot use a change producer (single-statement autocommit only).

The task: make the pane an ordinary live, bounded, paged collection, load each op's detail when its row is opened, and do not bring back the churn loop.

### What changed since v1, and why

v1 kept all five lists as JSON and merged them in one SQL upsert, with `callers` capped at the top 50 + `(other)`. Measured on main (2026-10-13):

| | Value |
|---|---|
| ops / occurrences | 7,110 rows, 1.2 M occurrences since 2026-06-14, about 0.5 writes/s on average |
| row size | 1.6 KB average (samples ~1 KB, callers ~360 B, waits ~10 B); 27 MB table |
| callers | 36,354 entries; 93 ops have more than 50; **a cap of 50 would fold 10,838 named callers (30%)** |
| variants | 35 entries in the whole table; 2 ops ever folded |

So:
- The cap on `callers` throws away too much. `callers` is also the only list with unbounded cardinality (route paths carry ids), so it is the one list that belongs in its own table: one row per (op, caller), additive upserts, nothing folded, read top-N and paged at read time.
- The other four lists are small and bounded. Moving them into tables (as an alternative design proposed) would add a samples trim, more producers and a heavier migration for no measurable gain, so they stay as JSON merged in SQL, as in v1.

## Decision

1. **`slow_ops`** (one row per op) keeps its counters and the four bounded JSON lists: `waits`, `variants` (top 10 + `(other)`, as today), `measures`, `recentSamples` (newest 10). The `callers` column is removed. It becomes a volatile change producer (2 s coalesce), and each batch writes it with **one** multi-row `INSERT … ON CONFLICT DO UPDATE` whose list merges are SQL expressions. This is v1's write path minus `callers`.
2. **New `slow_op_callers`** (one row per op × caller): counters only, written with **one** additive multi-row upsert per batch, its own volatile producer (2 s coalesce), its own 30-day retention. No cap: every caller keeps its own row.
3. **Reads:** the slim `slow-ops.ops` window for the list, the `slow-ops.op` lookup for the detail header and lists, and a new `slow-ops.callers` window for the detail's callers, paged and sorted by total time.

## Schema & migration

**`slow_op_callers`** (new, `server/internal/tables.ts`, via `defineEntity` like `slow_ops`):

| column | type | note |
|---|---|---|
| `id` | uuid, `defaultRandom()` | row identity for the collection |
| `worktree`, `operation_kind`, `operation` | text | the op's key, the same three columns as `slow_ops`' unique key |
| `caller_kind`, `caller_label` | text | the `CallerRef` |
| `count` | int | |
| `total_ms`, `max_ms` | float8 | |
| `first_seen_at`, `last_seen_at` | timestamptz | `last_seen_at` drives retention |

- Unique index `(operation_kind, operation, worktree, caller_kind, caller_label)`: the upsert target.
- Index `(operation_kind, operation, total_ms DESC, id)`: the detail's paged window.
- Index `(last_seen_at)`: the retention sweep.
- The op is referenced by its text key, **not** by `slow_ops.id`. The live filter cannot compare a `text` operand with a `uuid` column (`network/live/plugins/filter/CLAUDE.md:60-63`), and the text key also needs no lookup on the write path.
- No foreign key. A cascade delete would bypass the producer. Retention handles cleanup instead: a caller's `last_seen_at` is never later than its op's, because every caller occurrence also bumps the op. So when an op ages out after 30 days, its callers have already aged out (or do so in the same sweep).
- `ExcludeFromFork`, like `slow_ops`.

**`slow_ops`:**
- Keep `callers` in `slowOpFields`, marked legacy (see Migration); wire reads use `SlowOpDetailSchema` (every column but it) and `SlowOpListRowSchema`.
- Add v1's two indexes: `(total_ms DESC, id)` and `(last_seen_at DESC, id)`.

**Migration** (one push, per `database/plugins/migrations/CLAUDE.md` § Phased schema migrations):
- expand: `CREATE TABLE slow_op_callers` plus its indexes; the two `slow_ops` indexes.
- data migration (`--custom-migration`, idempotent): `INSERT INTO slow_op_callers (…) SELECT … FROM slow_ops, jsonb_array_elements(callers) … ON CONFLICT DO NOTHING`, with `first_seen_at` / `last_seen_at` taken from the op row (the JSON carries no per-caller times). About 36 k rows.
- ~~contract: `ALTER TABLE slow_ops DROP COLUMN callers`.~~ **Split out (implementation finding).** Migrations apply in the NEW backend's boot while the old one keeps serving (`gateway/CLAUDE.md` hot restart), so a drop in this push would fail the old backend's upserts for the swap window. This push stops reading and writing `callers` (the column stays, with its default, marked legacy in `slowOpFields`); a follow-up push drops it. Callers the old backend merges into the JSON during the swap window (after the backfill ran) are not copied: seconds of caller attribution, counts on `slow_ops` unaffected.

## Write path

`recordSlowOpBatch` keeps everything around the write unchanged: per-item `occurredAt` stamping, the per-item `slowOpShed.admit` gate, `runInBackgroundLane(() => runWithoutProfiling(…))`, one `getContentionSnapshot()` per batch, then the per-item marker publish and `recordReport`.

Inside the scopes:
1. **`foldSlowOpBatch(items, snapshot)`**, a new pure function in `fold-batch.ts`, returns two sorted row lists:
   - **op rows**, one per (kind, op), exactly as v1: summed counters, min/max times, newest-wins `lastMs`/`thresholdMs`, `waits` summed, `recentSamples` newest 10, `variants` top 10 + `(other)`, `measures` max/last;
   - **caller rows**, one per (kind, op, callerKind, callerLabel) for items that carry a caller: `count`, `totalMs`, `maxMs`, first/last seen.

   Folding merges and drops nothing; it exists because Postgres refuses an `ON CONFLICT` that touches one row twice in one statement. Rows are sorted by key so concurrent batches from two backends during a hot swap lock in the same order and cannot deadlock.
2. `await slowOpsProducer.mutate(db, (q, t) => buildOpUpsert(q, t, opRows), { latency: "background" })`: v1's SQL merges for counters, `waits`, `recentSamples`, `variants`, `measures` (`merge-sql.ts`).
3. If there are caller rows: `await slowOpCallersProducer.mutate(db, (q, t) => buildCallerUpsert(q, t, callerRows), { latency: "background" })` with
   `count = slow_op_callers.count + EXCLUDED.count`, `total_ms = … + EXCLUDED.total_ms`, `max_ms = greatest(…)`, `first_seen_at = least(…)`, `last_seen_at = greatest(…)`.

**Transaction shape:** two autocommit statements per batch instead of one transaction of 2N statements. It is still a fixed number per batch, which is what the batched-beacon fix needs (it went from 438 transactions to one per batch). The two statements are not atomic together: between them the detail can show callers lagging the op's counters by one batch. If the second statement fails, the batch throws loudly as today, and the op counters are already committed. Both are acceptable for a debug aggregate.

**Removed:** `upsertSlowOpIn`, `SlowOpTx`, the read-back and the second UPDATE, `mergeCaller` (replaced by the fold and the SQL sum). Test seam: `writeSlowOpRows(opRows, callerRows, executor = db)`, following reports' `writeReport`.

**Producers** (`server/internal/producer.ts`): `slowOpsProducer` and `slowOpCallersProducer`, both `durability: "volatile"`, `coalesce: { ms: 2000, … }`, copying `plugins/reports/server/internal/producer.ts`. In `server/index.ts`, replace `ExcludeFromChangeFeed({ table: _slowOps })` with both `.declare`s. Every writer runs in the serving backend (the `onSlowSpan` hook, the client POST handler, the per-worktree boot-monitor job, retention), so a volatile producer is valid. `defineRetention` already deletes through the producer (`define-retention.ts`).

## Why the churn loop cannot recur

As in v1, for each of the two tables:
- A produced table has no trigger, no changelog row and no NOTIFY.
- The flush rate is capped at one per 2 s per table, however many occurrences arrive.
- Each flush refills only the changed ids of each open window, plus one bounded top-N query.
- The write runs unprofiled in the background lane, so it cannot record itself as slow.

At a burst of 100 occurrences/s with the pane open: about 200 NOTIFY/s each followed by a 19 MB reload today, against at most 1 flush/s across both tables, each a few KB. The callers table also removes the last unbounded per-row cost: a write adds to a few counter rows instead of re-aggregating a 457-entry JSON list.

## Read path

**`core/resources.ts`:** delete `slowOpsValue` and `server/internal/slow-ops-served.ts`.
- `slowOpsList = liveCollection("slow-ops.ops", …)`: as v1. A slim row (counters, `firstSeenAt`, `lastSeenAt`, plus `waitMs` and `lastTraceId` as `expr` fields), default `totalMs desc`, limit 100, `maxLimit` 500, scroll, filter on kind/operation, sort on the counters.
- `slowOpById = liveCollection("slow-ops.op", { row: SlowOpSchema, id: "id" })`: lookup only, as v1. Now without `callers`.
- **New** `slowOpCallers = liveCollection("slow-ops.callers", …)`: row `{ id, operationKind, operation, callerKind, callerLabel, count, totalMs, maxMs, lastSeenAt }`; filterable `operationKind`, `operation` (`liveText`) and `callerLabel`; sortable `totalMs`, `count`, `maxMs`, `lastSeenAt`; default `totalMs desc`, limit 50, `maxLimit` 500, scroll.

No `count: true` and no preload: A6 forbids an L2-persisted reader of a volatile produced table.

**Pane** (`plugins/pane/web/components/slow-ops-view.tsx`): as v1. A `DataView` over `liveDataSource(slowOpsList, …)`; clicking a row pushes the detail pane. The Refresh button, the client-side sort and the inline `↳` caller lines are removed from the list.

**Detail pane** (`slow-op-detail.tsx`, route `op/:id` under the traces list, template `trace/pane/web/panes.tsx`):
- `useLiveRow(slowOpById, id)`: loading, error, not-found ("aged out by retention") and found states. The found state shows the scalar header and in-memory DataViews for waits by layer, variants, measures and recent samples.
- **Callers:** a `DataView` over `liveDataSource(slowOpCallers, { where: { operationKind, operation } })`, using the found row's key. Paged, sortable, searchable by label. Every caller is named, with no `(other)`.
- It updates live, at most every 2 s, and only when that op or its callers change.

**Reports KindView:** unchanged. It reads only the report's own data.

## Semantics preserved

- **Cold-start attribution:** `transportWaitMs` still goes to the `notifications-transport` wait layer, and `transportColdStart` still goes into the per-item report data.
- **Nothing filtered:** every admitted item is counted on its op and, when it has a caller, on its caller row. Every item still writes its marker line and files its report. Nothing is capped that is not capped today (variants top 10, samples newest 10).
- **Batched client beacon:** `slow-op-queue.ts` is unchanged. A batch is one snapshot and two statements.
- **Job work-time thresholds:** `resolve-threshold.ts` and `install-slow-span.ts` are unchanged.
- **Retention:** 30 days on `last_seen_at` for both tables, per worktree. **Fork exclusion:** both tables.
- **Replay is order-insensitive:** least/greatest times, newest-wins guards, sums and max are exact.

## Cluster tab and Timeline

- **Cluster** (`cluster/server/internal/handle-cluster.ts:25-32`) selects `callers` today. Its UI (`aggregate.ts`) does not use it. Trimming the SELECT and `ClusterSlowOpSchema` to the columns `aggregate.ts` uses is now **required**, not optional: a rebuilt fork has no `callers` column. The trimmed SELECT reads both old and new forks. `ClusterSlowOpSchema` becomes an explicit `.pick({…})` mirroring the SELECT.
- **Timeline** (`timeline/server/internal/sources/slow-ops.ts:38`) selects `id, worktree, operation_kind, operation, threshold_ms, recent_samples`: no change.
- No other code reads `slow_ops.callers`.

## Docs to update

As v1 (slow-ops `CLAUDE.md`, change-feed `CLAUDE.md`, sql-column `CLAUDE.md`'s 19 MB measurement, research doc `2026-10-11-global-endpoint-reads-onto-live.md` Open (B3), the stale "like slow_ops" comments), plus: slow-ops `CLAUDE.md` describes `slow_op_callers` and why `callers` alone left the row (unbounded cardinality; measured 30% loss under a cap).

## Steps

1. Schema: `slow_op_callers` and its indexes, the two `slow_ops` indexes, `callers` removed from `slowOpFields`, the data migration. Check the hot-swap ordering of contract (see Migration) and split the push if needed.
2. Producers: both tables; swap the exclusion for the `.declare`s; retention for `slow_op_callers`; `ExcludeFromFork` for it.
3. `fold-batch.ts` (op rows plus caller rows), `merge-sql.ts`, `buildOpUpsert`, `buildCallerUpsert`; rewrite the body of `recordSlowOpBatch`; delete `upsertSlowOpIn`, `SlowOpTx`, `mergeCaller`.
4. Cluster: trim the SELECT and switch `ClusterSlowOpSchema` to an explicit pick.
5. Collections: `slow-ops.ops`, `slow-ops.op`, `slow-ops.callers`; `server/internal/resources.ts`; delete `slow-ops-served.ts`.
6. Pane: list DataView, route, detail pane with the callers DataView.
7. Tests, docs, build, verification.

## Critical files

- `plugins/debug/plugins/slow-ops/core/{schema.ts, resources.ts, routes.ts (new)}`
- `plugins/debug/plugins/slow-ops/server/index.ts`
- `plugins/debug/plugins/slow-ops/server/internal/{tables.ts, retention.ts, producer.ts (new), fold-batch.ts (new), merge-sql.ts (new), merge-detail.ts, record-slow-op.ts, resources.ts (new), slow-ops-served.ts (delete)}`
- `plugins/debug/plugins/slow-ops/plugins/pane/web/{index.ts, panes.tsx (new), components/slow-ops-view.tsx, components/slow-op-detail.tsx (new)}`
- `plugins/debug/plugins/slow-ops/plugins/cluster/{shared/endpoints.ts, server/internal/handle-cluster.ts}`
- Precedents: `plugins/reports/server/internal/producer.ts`, `plugins/debug/plugins/trace/plugins/engine/{core,server/internal}/resources.ts`, `plugins/debug/plugins/latency-ledger/server/internal/store.ts:63` (`EXCLUDED` spelling), `plugins/debug/plugins/reports/web/components/reports-view.tsx`, `plugins/debug/plugins/trace/plugins/pane/web/panes.tsx`.

## Verification

- `./singularity test plugins/debug/plugins/slow-ops`:
  - `fold-batch.test.ts`: folding a batch equals applying its items one by one (out-of-order `occurredAt`, ties, same op with several callers).
  - DB-backed `record-slow-op.test.ts`: an equivalence oracle (random item sequences through the old JS merges against the fold plus both upserts: equal counters, waits, samples, measures, variant totals, and per-caller counts equal to the old `callers` list); first insert of a key; two concurrent overlapping batches complete without deadlock; emitted ids for both producers (`mountProducersForTest`, `flushNow`).
  - Cluster `aggregate.test.ts`.
- `./singularity build` (background, then `./singularity await`): `change-feed:producer-writes`, `migrations-in-sync`, `migration-phases-valid`, `type-check`, `no-db-backed-notify`, plugin boundaries; boot assertions A2′, A3p, A6.
- `query_db` on this worktree:
  - the `slow_op_callers` row count matches the sum of the old `callers` array lengths (about 36 k on a fork of main);
  - no `live_state_*` trigger on either table;
  - `n_tup_upd` grows by about one per key per batch.
- e2e: `screenshot.ts --path /debug/traces --click "Aggregates"`. Open an op that has more than 50 callers and confirm that every caller pages in. Confirm the Cluster and Timeline tabs still read main and an un-rebuilt fork.
- Churn: with Aggregates and a detail open, send a burst of 200-item beacons. `get_runtime_profile` should show each producer flushing at most every 2 s, with KB-sized frames, and the rows should update without Refresh.
