# Scoped change routing: compiler-emitted routes and per-tuple read-sets

## Context

A live resource has exactly one `identityTable`. A write to any **other** table its loader reads takes the
uncovered-origin branch of `applyDbChange` (`resource-runtime/core/runtime.ts:5019-5022`, `affected = null`), and
every subscribed tuple of that resource key reloads in full. It even reaches tuples whose SQL never read that
table, because the read-set is one append-only union per resource key:
- capture: `runtime-profiler/core/recorder.ts:1591-1603`, labelled by key at `server-core/core/resources.ts:245-250`;
- inversion: `tableToResources()`, `runtime.ts:1536-1562`.

Resources page item 7 (API half) is blocked on this. That item folds the revision-tick lists (conversations, runs,
mail, events, deploy, release and reports history) and the Sonata library into `useLive` windows. Those windows
sort and filter on joined side-table columns, so every side-table write would reload every window.

**The outcome we need:**
- a write to any table whose changed ids → host ids mapping is knowable costs O(changed);
- it reaches only the tuples whose query actually reads that table;
- anything unmappable stays a declared, bounded FULL;
- the mapping comes from the code that writes the SQL;
- producers other than the Postgres feed use the same path;
- boot assertions keep rejecting routes that cannot be routed.

### What the investigation found (beyond the task statement)

- **Routing depends on the profiler.** `recordReadTables` returns early under `SINGULARITY_PROFILING=0` or
  `runWithoutProfiling` (`recorder.ts:1370-1377`). With the kill-switch on, `tableToResources()` is empty and
  **nothing routes**.
- **The `pushes → attempts` edge is FULL on every push write** (bug C1). The carrier `pushesAttemptsCascade`
  (`tasks-core/server/internal/resources.ts:164-169`) declares no `identityTable`, so `pushes` is uncovered. The
  carrier drains FULL, the cascade stays FULL (`runtime.ts:2920`), and the `rel()` hop never runs. The comment at
  `resources.ts:210-216` claims the opposite.
- **Skipping a persisted tuple reloads it in full.** An "ack-only" pending (empty `affected`) on a persisted
  non-membership entry is loaded FULL: `scoped = affected !== null && !persisted` (`runtime.ts:3592-3600`). A
  router that skips tuples by scheduling an empty set would therefore reload them.
- **A refilled non-member always counts as `entered`** (`runtime.ts:3268-3276`), which forces a `windowIdsOf`. A
  side-table write to a row outside the window would cost O(window), not O(changed), unless the router drops it
  first.
- **Joins are not structured data anywhere in the compilers.**
  - The compiler seam is `from(ONE relation)` (`query-resource/server/internal/spec.ts:48-61`).
  - Views are opaque `PgView`s, and `view_table_usage` gives relation-level usage only.
  - The only structured joins are opaque closures: `DataViewJoin.apply` (`server-query/.../augment.ts:44-46`), and
    `event-list/.../handle-query.ts:75-80`. Both serve HTTP endpoints, not live resources.
  - No live loader joins a side table into its host today; every extension is its own resource, joined client-side.
- **The trigger sends only single-column-PK ids** (`change-feed/.../triggers.ts:145-167, 243-260`):
  - composite or missing PK → `ids = NULL`;
  - payload over 7000 bytes → `ids = NULL`;
  - a DELETE carries the PK only;
  - an UPDATE reads `new_rows` only, so a key-changing UPDATE loses the old id.
- **`RecomputeIntent` is built and then discarded** (`runtime.ts:5082-5093`, `void intent`).
- **Only one path reaches the runtime:** `routeChange` (`route-change.ts:24-54`), called from the LISTEN
  consumer, L2 catch-up and the reconnect `fullSweep`. Every in-process producer goes through `notify()`, which
  cannot name a table.

## Decisions (user, 2026-09-29)

| Decision | Choice |
|---|---|
| Scope | **P0–P4 in this task.** P5–P8 go into **one** follow-up task, filed after approval. |
| Reports producer (P5) | **Volatile, after commit.** An in-process emit once the transaction commits: no changelog row, no NOTIFY, no extra writes during crash storms. Boot assertion A6 forbids L2-persisted readers. |
| Trigger payload | **Routed tables only, with the changed-columns gate.** Only tables a compiled route reads get the richer trigger, and its layout is derived from the registered routes. Every other table keeps its trigger byte-identical. |
| Framework changes | This plan changes `plugins/framework/plugins/resource-runtime` and `server-core`. Approving the plan approves them. |

## Status (2026-09-30): P0–P4 landed, uncommitted, awaiting review

Everything this task scoped (P0–P4) is implemented in the worktree; P5–P8 are
the follow-up task. Per phase (each has its own "as landed" section below):

| Phase | Landed |
|---|---|
| **P0** runtime seam | `routing.ts` (`TableChange`, `HostMap`, `Route`, `TupleUse`, minted `RoutePlan` / `ReachPlan`), `routeTableChange`, the `tracked` index, `pendingAcks` (a skip is never a pending), `draining`, reverse resolution in the drain, the runtime-owned read-set capture (independent of the profiler kill-switch), the read-set version memo; `RecomputeIntent` deleted. |
| **P1** identity routes | Every `serveCollection` resource (window, `:rows`, `:groups` via `reach`) routed; A1 (type + throw), A5, A7 (Read-set pane), A8 (drift guard), A9, T3 (minted plans + `compiled-routes` check). |
| **P2** joins + the DataView adapter | `JoinSpec` / `ext.join()` / T2 / A4, provenance read off the rendered SQL, value role + quiescence guard, per-tuple order signature; the live DataView source (`liveDataSource`, `useLiveScroll`'s segmented scroll, contributed columns, `useResources`); proof conversions: mail threads and the Sonata library (their revision ticks and `unbounded` values deleted). |
| **P3** trigger layout | `live_state_notify_routed` on routed tables only (unrouted triggers byte-identical), old ∪ new ids / keys, the changelog's `keys` + `unchanged`, per-table trigger state, A3; custom columns as a scoped join family with routed `recomputeOn`; proof conversions: release history and deploy history. |
| **P4** lookups + gate | Compiled `reverse` routes with batched probes (cap 500), A10, `TupleUse.moves` (membership-neutral U as value), default scopes, the `unchanged` fact replacing `changed`; proof conversion: the events list (`events.revision` deleted). |
| **Final review** | Snapshot writers are span-owned and base-version-guarded; header sort follows the source; typed truncation; awaiting scopes; lint, type and doc fixes (section above the follow-up task). |

**Known limits and caveats** (beyond *Known limits* below, which still hold):

- Behaviour changes users will see, recorded and accepted or awaiting a
  decision: events tags are no longer matched by the search box (a filter-
  language op, not live API — needs the user's call); enum and source group
  sections follow stored-value order; nulls sort last in both directions under a
  live source; a live DataView scroll holds at most 16 segments and says so.
- `mailAccount` is not preloaded (one dependent round trip when Mail opens,
  now shown as the list's own loading state).
- A field-extension contributor's crash still replaces the surface below it
  (the fold renders the rest inside each contributor).
- This worktree's database keeps an unused `changed` changelog column from P3's
  deploy (main never had it).
- `mailbox-tabs-verify.ts`'s bare `/mail` redirect step needs a Gmail token this
  worktree does not have; `source-actions-verify` was not re-run (it enqueues
  real refresh runs).
- Test-suite failures seen in the final sweep that this change does not touch
  (the files are unchanged against the merge base): `database/core/internal/
  config.test.ts` (reads the ambient connection instead of the fixture's
  `database.json`), `web-sdk/core/load-tiers.test.ts` (the committed tier
  manifest, identical to main's, pins studio's explorer eager), and
  `type-check/check/prepare-thread.test.ts` (a warm-base pool left by a
  concurrent type-check run).

**Final verification:** `./equin format` (5 files rewritten); a sweep of
`./equin test` over the 45 plugin roots the diff touches — 3710 pass, 5
fail: the three unrelated failures above, plus the live lint barrel test timing
out at 5 s under load (it passes re-run alone); `./equin build` success
(its checks include `type-check` and `plugin-boundaries`).

## Status (2026-10-02): P5 landed in `3f7fe72db4`

Steps 7–14 (P6, P7 and the item-7 remainder) are tracked in
`research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md`, whose "As landed" section records them.

P5 of the follow-up plan (`research/2026-10-01-global-scoped-change-routing-p5-p8.md`), as landed:

| Piece | Landed |
|---|---|
| **Change producer** | `defineChangeProducer` (change-feed): the producer owns the write verb — `mutate(pool, (q, t) => builder, { latency })` appends `RETURNING <pk>` and emits exactly the returned ids (`U` / `D`), after commit by construction (a transaction executor is a type error). Coalesced at the source (fixed 2 s window for `reports`, last op wins, deletes before upserts, `ids: null` over 1000); `interactive` flushes at once. Each change of a flush routes on its own (a throw is filed, the rest still route); the window is unref'd and dropped on shutdown. |
| **Guards** | A1′ (a produced table counts as covered), A2′ (one producer per table; not also opted out or a rollup; no `live_state_*` trigger survives on it), A3p (no route on a produced table carries a column — also asserted on the real `reports.list` routes in its oracle), A6 (no L2-persisted reader: boot static evidence throws, stale rows are swept, a persist naming one is refused — the persist gate itself never flips; the reports are held until `onAllReady`), A11 (`change-feed:producer-writes` check, names scoped per file: aliases, re-binds and property access followed; only the builder a producer's `mutate` returns is exempt), A12 (unmounted producer throws), A13 (outside the serving backend throws; `reap-job` files through the outbox). |
| **reports** | `reports.list` is a `serveCollection` (window, `:rows`, `:groups`) fed by `reportsProducer`; every writer (`recordReport`, `linkReportTask`, `setReportNoise`, retention's `sweepExpired`) goes through it. `reports.revision`, `queryReports`, `reportFacets`, `getReport` and `ExcludeFromChangeFeed(reports)` are deleted; the Reports pane, detail pane and facet filters read the live collection. |

**Known limits added by P5** (also listed under *Known limits* below):

- Volatility: a pending coalesced change is lost on a restart or hot swap; clients resubscribe and reload in full. Within one subscription a lost emit heals membership (`windowIdsOf`) but not the values of rows already in the base. A6 keeps "lost" from ever becoming "persisted wrong".
- A producer change carries no `unchanged` set, so a `:groups` tuple over a produced table recomputes its whole `GROUP BY` on every flush that touches the table, even when only a non-grouped column (`count`) moved — bounded by the 2 s window, one aggregate per open grouping.
- A slow `reports.list` recompute files a `slow-op` report, which is itself a `reports` write: at most one such round per 2 s window (the same loop existed through the old revision refetch).
- `recordReport` throws in an exec child (A13). The outbox is not a drop-in replacement there — it records on main's database, and cannot return the `RecordReportResult` — so a caller that may run in an exec child files through `fileReportFromProcess` itself.

## Design

### Core idea

The collection compiler already writes the loader, the scoped refill, `windowIdsOf` and `:groups`. It now also
takes **declared joins as data** and emits two more things from that same data:
1. a list of **routes**: for each table the query may read, how that table's changed rows map to host ids;
2. a pure **`usesOf(params)`**: the per-tuple read-set, i.e. which route occurrences THIS tuple's SQL performs,
   and in which role.

The runtime gets a new SQL-free entry, `routeTableChange(TableChange)`. Every producer calls it, and it serves
routed entries only. The legacy `applyDbChange` path keeps serving unrouted entries untouched, so resources
migrate one at a time and each move is reversible.

### Runtime contract (`resource-runtime/core/routing.ts`, new; SQL-free, names no contributor)

```ts
interface TableChange {                     // table is always a BASE table
  table: string; op: "I" | "U" | "D";
  ids: readonly string[] | null;            // single-column PK as text; null = unknown rows
  keys: Readonly<Record<string, readonly (string | null)[]>> | null;  // emitted layout, row-aligned; U = old ∪ new
  changed?: readonly string[] | null;       // U on a gated table: routed columns that differ; null = unknown
  xid?: string; changedAt?: number;
}

type HostMap =
  | { kind: "identity"; column?: string; encode?: (v: string) => string } // rows ARE host rows; D ⇒ gone
  | { kind: "alias"; column: string; encode?: (v: string) => string }    // row carries its host key; I/U/D ⇒ host U
  | { kind: "reverse"; column: string;                                   // host side references it; resolved in the drain
      resolve(changed: readonly string[], within: ReadonlySet<string> | null, cap: number)
        : Promise<readonly string[] | "over-cap"> }
  | { kind: "full"; reason: string };

interface Route {
  id: string; table: string; map: HostMap;
  columns: readonly string[];               // columns of `table` the SQL references (compiler-emitted only)
  rows?: Readonly<Record<string, string>>;  // static key filter, e.g. { data_view_id: "<surface>" }
}
interface TupleUse { role: "membership" | "value"; match?: Readonly<Record<string, ReadonlySet<string>>> }
interface RoutePlan<P> { routes: readonly Route[]; usesOf(params: P): ReadonlyMap<string, TupleUse> }
```

**How the types enforce the rules:**
- `ScopePolicy` (`runtime.ts:441-469`) gains `routes?: RoutePlan<P>`, **only on the `membership` and
  `scopedMembership` arms**. `fanOut` and `recompute` cannot carry routes, so the rule "a scoped refill never
  deletes" holds by construction.
- Non-keyed entries (`:groups`) get a `reach` arm whose routes may only be `full`.
- A table may carry several routes (a self-join is identity + reverse on one table). Their host ids are unioned,
  and a FULL absorbs the rest.
- For a routed entry, `identityTable` is derived from its routes rather than declared.

### Join vocabulary (`infra/query-resource/core`, data only)

```ts
type ColumnRef = { from: "base" | string /* join alias */; col: PgColumn };
type JoinSpec =
  | { kind: "extension"; alias: string; table: PgTable; key: PgColumn }            // LEFT, key = host pk
  | { kind: "lookup"; alias: string; table: PgTable; pk: PgColumn; on: ColumnRef; required: boolean } // N:1, chainable
  | { kind: "keyed-side"; alias: string; table: PgTable;                            // composite-keyed side table
      selectors: ReadonlyArray<{ col: PgColumn; value: string }>; hostKey: PgColumn };
```

**Where the specs come from:**
- An extension handle returns its own spec via `ext.join(alias)`. `define-extension.ts:151-186` already holds
  `parentTable` and `key`.
- The custom-columns augmentor returns a `keyed-side` spec. `DataViewJoin.apply` is replaced by
  `applyJoin(q, spec)` in `server-query`, so the four HTTP handlers keep working on the same data.

**How `serveCollection` uses them:**
- It gains `joins: JoinSpec[]`.
- Column overrides become `(j) => ColumnRef` over the declared joins. Today an override can name another table's
  column and silently produce invalid SQL (`serve-collection.ts:210-229`); with this change that cannot be
  written (T2).
- The `QueryDb` seam (`spec.ts:48-61`) gains `leftJoin` / `innerJoin`, and so does the test fake.
- `renderPlan(shape)` joins exactly `usesOf(params)`'s relations for every shape (full, scoped, ids, groups). The
  loader, `windowIdsOf` and the reverse query therefore cannot disagree about what they read.

**How a tuple's role is derived (compiler only):**
- `membership` if the join is `required` (INNER), or if the tuple's decoded `where` / `order` references a field
  whose provenance is that join or a later join in its chain.
- `value` otherwise: a LEFT join that is only projected, which provably cannot change membership.
- A joined sort field must be projected and included in `signatureColumns` (extends `compile-window.ts:239-274`),
  so the existing order-signature compare catches real reorders.

### Algorithm

**`routeTableChange` is synchronous and schedules everything inside one `withNotifyBatch`:**
- The index is `Map<table, {entry, route}[]>`. It is static, built at `createResource`, and needs no memo.
- Targets are `entry.tracked` (a `pk → params` map maintained next to `subCounts`, `runtime.ts:4560-4599`). They
  include `{}` only when the entry's params are empty; windows and points never get `{}`. This removes the O(sockets)
  `subscribedParamsFor` scan from this path.

For each target tuple, walk `memoUsesOf(entry, pk)`. If `usesOf` throws, report it and FULL that tuple (fail
open). For each route this tuple uses:
1. **Gate.** A U whose `changed` misses every column in `route.columns` is skipped.
2. **Key filter.** Filter the rows of `keys` by `route.rows` and `use.match`. If the keys are known and no row is
   left, skip the route.
3. **Unknown values.** If the values are unknown (`keys` null and the column is not the PK), or the route is
   `full`, the tuple goes FULL.
4. **Map by kind:**

   | Kind | Result |
   |---|---|
   | `identity` | D goes to `deleted`; otherwise the ids go to `affected` |
   | `alias` | the ids go to `affected`, whatever the op: **a side-table I/U/D is a host U, never a host I/D** |
   | `reverse` | pushed to `pending.unresolved` |
5. **Shape by membership kind.**
   - Point: intersect with `idsOf(params)`.
   - Window or alias: value-role ids are intersected with the snapshot keys, **only while the pk is quiescent**
     (no pending and not in `entry.draining`). Otherwise they are delivered as membership. Why the guard: a drain
     that is admitting host h may have read the side table before this write committed. Dropping the change then
     would leave h stale for good.
6. **Nothing left.** If nothing remains and the change has an `xid` that this tuple wants acked, add the xid to
   `pendingAcks`.

**Op semantics in one line.** An identity D means the row is gone. Everything else is "these host rows may have
changed". `drainMembershipScoped` (`runtime.ts:3198-3529`) already turns that into the right outcome:
- a requested member the refill omits is an **exit** (joined filter flipped, INNER lookup row gone, host
  deleted);
- a refilled non-member is a candidate that `windowIdsOf` arbitrates;
- a signature move is a **reorder**.

**Drain changes (`drainEntry`, `runtime.ts:3537`):**
1. **`pendingAcks` split.** A new `entry.pendingAcks: Map<pk, {params, xids}>` replaces the "empty `affected`"
   spelling of a skip.
   - If a real pending exists for the pk, the xids are merged into its `sourceTx`.
   - Otherwise `broadcastAckOnly` runs before any persisted or membership branch.
   - A skip can no longer be spelled as a reload, which fixes the `runtime.ts:3592-3600` bug.
   - The point empty-intersection path (`runtime.ts:5059-5072`) moves onto it.
2. **Reverse resolution.** For each (entry, route) and each flush:
   - Take the union of `changed` over the pendings.
   - `within` is the union of member snapshot keys when every pending is value-role; otherwise it is null. For a
     point it is `idsOf`.
   - Call `resolve(changed, within, cap = 500)` once, under `wrapOrigin("cascade", key)`.
   - `over-cap` or a throw turns those pendings FULL; a throw is also reported.
   - Distribute the result, intersected with `within` for each pending.
   - Because it runs in the same pending as the identity ids of that xid, the ack leaves only after every route
     has landed.
3. The rest of the drain is unchanged. `lastNotifyAt` / `notBefore` are refreshed by `mergePending` exactly as
   today (`runtime.ts:2087-2095`).

**FK-direction rule (checked at compile time, A10).** A reverse route resolved after commit is complete if no hop
reads the changed table itself. The referencing column lives on host-side rows, which still exist. For example,
`events WHERE source_id IN :changed` is complete even when the source is deleted. A hop *through* the changed
table needs that column carried in `keys`, which the trigger takes from `old_rows` for U and D. If it is not
carried, the compiler emits `full: "pre-image needed"`.

### Producers

**Postgres triggers, routed tables only (decision).**
- `routedTableRequirements()` is derived from every registered `Route` and gives, per table:
  - **carry** columns: `identity` / `alias` / `reverse` columns, plus the keys of `rows` / `match`;
  - **gate** columns: `route.columns`, used only when they are a strict subset of the table's columns and the
    table has a single-column PK.
- Resources register before the change-feed's `onReadyBlocking` rebuilds triggers (`change-feed/server/index.ts:59-68`
  already reads the registry there for its assertion).
- On routed tables only:
  - the UPDATE trigger also declares `OLD TABLE AS old_rows`;
  - `keys` is DISTINCT over old ∪ new (DELETE takes it from `old_rows`);
  - `ids` is old ∪ new, which fixes the lost old id on a key-changing UPDATE;
  - `changed` is computed by joining old and new rows on the PK; if a PK changed, it is NULL ("unknown").
- Over the cap, `ids`, `keys` and `changed` all become NULL.
- `live_state_changelog` gains `keys jsonb, changed text[]`, and catch-up replays them.
- A changed layout changes the trigger signature, which causes one per-table rebuild at the next boot. That
  rebuild is already designed to be safe (`triggers.ts:394-414`).

**One feed entry.** `routeChange` builds a `TableChange` and calls `routeTableChange` (routed entries), then calls
legacy `applyDbChange` with view forwarding, unchanged. `tableToResources()` skips routed keys, so each entry is
reached exactly once. Catch-up and `fullSweep` inherit both paths through `routeChange`.

**In-process producers** are P5, in the follow-up; the shape is recorded here.
`defineChangeProducer({ table, durability: "volatile", acks? }).run(db, (tx, emit) => …)` buffers `emit` calls and
calls `routeTableChange({ source: "producer" })` only after the commit resolves, so emitting before commit cannot
be written.

### Assertions and checks

| # | Rule | Rung |
|---|---|---|
| T1 | `routes` only on membership arms; `reach` arms accept only `full` | type |
| T2 | Column overrides are `ColumnRef`s over declared joins | type |
| T3 | A `RoutePlan` / `ReachPlan` is minted by a compiler, never written: a brand only `mintRoutePlan` / `mintReachPlan` set, an unminted-plan throw, and a check on who may call the minters | type + check + runtime |
| A1 | Every route table is a base table: not a view, not a rollup (`feedExemptTables`). A routed compile with a `PgView` `from` throws. `identity-coverage.ts` is generalised into `route-coverage.ts`. | boot / compile |
| A2 | Every route table has exactly one change source: triggered **xor** producer | boot |
| A3 | Every route's `column` / `rows` / `match` keys are in the table's installed trigger layout (read from the catalog trigger args) | boot |
| A4 | Each `ColumnRef.col` belongs to its relation; a lookup's `on` names an earlier relation; `keyed-side` selectors ∪ `hostKey` cover the PK; joined sortable fields are projected and signed | module eval |
| A5 | A `dependsOn` edge whose upstream is a routed entry throws ("route the table, not the resource"). This closes the lost update where a subscriber-less point upstream sits behind an edge-covered origin. | `createResource` |
| A6 | No persisted key (`shouldPersist`) reads a volatile-producer table | boot (P5) |
| A7 | The Read-set debug pane lists every `full` route with its reason, plus every legacy entry, so a FULL is never silent (landed in P1) | pane |
| A8 | Drift guard: when capture is on, the tables a routed entry's loader captures ⊆ its route tables. Otherwise a loud report; tests throw. | runtime |
| A9 | Route ids are unique per resource; an unknown id from `usesOf` is reported and FULLs that key | runtime |
| A10 | FK-direction rule | compile |

## Phases

**This task implements P0–P4.** Each phase keeps the build green, and all existing `runtime*.test.ts` suites pass
unchanged.

### P0: runtime seam (framework)

**Adds:**
- `routing.ts` types and `routeTableChange` (with no routed entries yet);
- the `entry.tracked` index;
- the `pendingAcks` split;
- `entry.draining`;
- `PendingNotify.unresolved`;
- a runtime-owned read-set capture sink (`server-core/core/resources.ts` + `recorder.ts`) that ignores the profiler
  kill-switch; the profiler still observes it;
- a `tableToResources` memo keyed on a read-set version counter (today's `${size}:${total}` signature breaks once
  entries are evicted).

**Deletes:** `RecomputeIntent` / `void intent`.

**Tests:**
- a persisted skip never loads;
- legacy routing still works under `SINGULARITY_PROFILING=0`.

**As landed (deviations from the text above, found in implementation and review):**
- **An empty scoped pending is a skip on every entry kind**, checked before the
  membership and persisted branches. On a membership tuple with no snapshot it used
  to reload FULL, which incidentally healed a tuple whose sub-ack load had failed;
  that client's `sub-error` HTTP fallback read covers it instead.
- **`TableChange.source` / `ChangeSource` are not in P0.** Nothing read them (every
  source routes the same), so they were dead plumbing; P5 adds a source together
  with the reader that needs it.
- **A sub-ack never regresses a snapshot a push advanced.** `serveSub` re-seeds only
  when no snapshot exists or the version is still the one it observed before its
  load. The value-role drop (P2) reads membership off that snapshot, so a sub-ack
  load that started before a drain admitted host h would otherwise un-admit h from
  the base and make h's later side write look like a non-member's.
- **One transaction's NOTIFYs route as one burst** (`change-feed/.../burst.ts`): the
  listener routes everything read off the socket from one macrotask, so a drain
  cannot run between two statements of one transaction and ship its ack before the
  second one reached the tuple. The guarantee is that macrotask boundary; it covers
  scoped refills' `ackTx` as well as standalone skip-acks.
- **A skip-ack is a feed delivery** for the hand-vs-feed counters and the
  read-set-gap match; a routed skip that owes no ack records nothing.
- **Routes on an external resource are refused** (type + `createResource` throw).

### P1: identity routes

**Changes:**
- `compileWindowQuery` and `:rows` (`query-resource/server/internal/compile-window.ts`) emit `identity` routes and
  a trivial `usesOf`.
- `groupsLoader` moves from `serve-collection.ts:318-346` into the compiler, with a `reach` arm.
- About 37 `serveCollection` resources move to the router.
- A1, A5, A8 and A9 land.

**Before landing:** grep every `dependsOn` / `recomputeOn` upstream so that A5 cannot fire at boot.

**Proof:** `runtime-window-membership.test.ts` driven through `routeTableChange`; the **mail threads** window
replaces `mail.threads.revision`.

**As landed (deviations from the text above):**
- **No `dependsOn` / `recomputeOn` / `rel()` targets a `serveCollection` resource** (checked before moving them):
  the upstreams in the tree are `conversationsActiveResource` (queryResource), `pushesAttemptsCascade` (a push
  `defineResource`), and `refHeadServed` / `editedFilesServed` / config values (`serveValue`). A5 now also fires
  in the other registration order (a routed entry registered after a downstream naming it).
- **The `reach` arm lives on `ServerResourceOptions`** (the non-keyed two-arg form), exclusive with
  `identityTable` by type; a keyed entry, a non-`full` route and an external resource throw. `serveValue`'s
  options are typed `reach?: never` — a value's loader is opaque, so it stays on the read-set path.
- **The groups compiler is `compileGroupsQuery`** in `query-resource`, beside the window compiler; the
  live-specific decode and the row-schema value check stay in `serveCollection` (passed as the per-tuple
  `query(params)`), since `query-resource` never imports `network/live`.
- **Route `columns` are every column of the table.** The compilers do not yet track which columns a `where`
  (opaque `SQL`) references, and the gate only acts once P3 sends `changed`; the full column list is the safe
  over-approximation (the gate never skips). P2's join vocabulary makes it exact.
- **An identity pk that is not the table's primary key routes by column** (`{ kind: "identity", column }`),
  which recomputes FULL until P3's key layout; every production collection keys on its table's primary key, so
  none takes that path today.
- **A1 is a type too:** `WindowQueryResourceSpec.from` is `RoutedSource` (`PgTable | EntitySource`), its
  `identity` lost the view-only `table`, and its `edges` are gone (a routed entry takes no cascade). A view
  from an untyped caller throws. `identity-coverage.ts` became `route-coverage.ts`, fed by the runtime's
  `scopedResourceTables()` (one row per route table, or per legacy `identityTable`), which replaced
  `scopedResourceIdentities()`.
- **A8 reads the per-run capture (`lastReadSet`)** after each routed loader run, whenever a capture is wired
  (not only under the profiler's `wrapLoad`); `strictRoutes` (server-core: `NODE_ENV === "test"`) throws
  instead of reporting.
- **The mail threads proof did not land.** `DataView` has no live-window data source: its server mode is
  `fetchPage(sort, filter, cursor, limit)` + a `changeTick` refetch (`use-server-data-source.ts`), and nothing
  hands the view's lowered `Filter` / `SortRule[]` to a `useLive` window or wires the infinite-scroll footer to
  `canGrow` / `loadMore`. Besides that adapter, the threads list needs: paging past `maxLimit` (the keyset
  scroll is unbounded; a window grows only to `maxLimit`); its account predicate
  (`account_id = (SELECT id FROM mail_accounts LIMIT 1)`, a second table — a P2 lookup, or a `full` route);
  and the `labels` field id mapping to the `labelIds` row field (a collection's filterable names are row
  fields). The proof is `runtime-window-membership.test.ts` under both routers, plus every `serveCollection`
  resource moving to the router. The mail threads window is **carried to P2** (below).
- **Added in P1 review:**
  - **Plans are minted, never written** (T3, the rule the prose used to carry alone): `RoutePlan` / `ReachPlan`
    carry a module-private brand only `mintRoutePlan` / `mintReachPlan` put on them (type), `createResource`
    refuses an unminted plan (runtime), and the `resource-runtime:compiled-routes` check allows the minters only
    in `query-resource/server/internal/routes.ts` and test code.
  - **A routed entry takes no `dependsOn`** (type on the routed `ScopePolicy` arms and the `reach` arm, plus a
    `createResource` throw): it routes the tables it reads, and a cascade would serve it twice.
  - **A7 landed:** the `_debug` payload carries each routed entry's routes; the Read-set pane lists every
    `full` route with its reason and checks a routed entry's captured read-set against its route tables.
  - **`routeChange` is tested end to end** (`change-feed/.../route-change.test.ts`): the real `routeChange`
    into the real server-core runtime (a routed and a legacy entry, each refilled once, scoped), and a real
    trigger → listener → `routeChange` → delta on a throwaway database. `rebuildTriggers` now takes the
    contributed exclusions as an argument (`getContributions` throws in an un-booted process, which had broken
    `triggers.test.ts` since that throw landed).

### P2: joins, extension alias, value role

**Changes:**
- `JoinSpec` and `ColumnRef`, with `ext.join()`;
- `QueryDb.leftJoin` / `innerJoin` (plus the test fake);
- provenance-driven `usesOf` and role;
- value-role intersection plus the quiescence guard;
- A4 and T2.

**Proof:** the **Sonata library** becomes a `songs` window joined to `_ext_playback` and `_ext_midi`, sorted and
filtered by `lastPlayedAt` / play count. This deletes the `unbounded` values `sonata-songs`,
`sonata-playback-history` and `sonata-song-midi`, and the pending → empty-map collapse in `usePlaybackHistoryMap`
/ `useSongMidiMap`.

**Carried from P1: the mail threads window** (it replaces `mail.threads.revision` and its `changeTick` refetch;
until then Resources item 7 stays blocked on it). It needs, besides its account predicate
(`account_id = (SELECT id FROM mail_accounts LIMIT 1)`; resolved in the adapter design below as a scope, not a
lookup):
- a **DataView → live-window adapter**: DataView's server mode is `fetchPage(sort, filter, cursor, limit)` plus a
  `changeTick` refetch, and nothing hands its lowered `Filter` / `SortRule[]` to a `useLive` window or wires the
  infinite-scroll footer to `canGrow` / `loadMore`. The adapter is its own piece of work — decide at P2 whether it
  lands here or as a separate task; it must not be dropped;
- paging past `maxLimit` (the keyset scroll is unbounded; a window grows only to `maxLimit`);
- the `labels` field id mapped to the `labelIds` row field (a collection's filterable names are row fields).

**Decided at P2 (user, 2026-09-30):** the DataView live-window adapter lands in P2, so the proof lists are
really converted. P2 is built in steps: the routing half first, then the adapter, then the list conversions.

**P2 routing half — as landed (deviations from the text above):**
- **Provenance is read off the rendered SQL**, not a declared field → join map. Every join renders against its
  alias (`"playback"."last_played_at"`), and `compileJoins` (`query-resource/server/internal/joins.ts`) walks a
  drizzle SQL fragment for the relations its column (and table) chunks name. A tuple reads a join when its SQL
  references it (projected, a required lookup, its `where` / order, or a join hung off it); its role is
  `membership` when it is required or its `where` / order reads it or a later join in its chain, else `value`.
  A relation a fragment reads that is neither the base nor a declared join throws ("declare it as a join"), which
  also catches a static `where` subquery like the mail threads' `mail_accounts` predicate. Raw `sql.raw` text is
  invisible to the walk.
- **Every shape of a tuple joins exactly `usesOf(params)`'s relations**, `windowIdsOf` included: a projected-only
  (value) LEFT join is joined into the ids query too. It is 1:1 or N:1 on a key, so it changes no row, and the
  loader and the membership authority then read one relation set (Verification §4 compares them literally).
- **Route columns are exact** over every tuple: projection, identity, join conditions, a static `where`, the order
  signature, plus a declared universe for a per-params `where` — `whereReads` on the window spec, `reads` on the
  grouping spec (`serveCollection` passes the filterable columns and its base predicate). Each tuple's `where` is
  checked against that universe (a column outside throws). A function `where` with none declared keeps the P1
  over-approximation (every column of every relation).
- **`HostMap.alias.column` is optional** (absent = the table's single-column PK, read from `change.ids` like an
  `identity` map). An extension is keyed by its host's id in its own PK, so its alias route is scoped TODAY on the
  PK-only trigger — it does not wait for P3's key layout. A keyed-side (`alias` on `hostKey`, non-PK) recomputes
  FULL until P3, and a lookup is `full` ("reverse routes land in P4") unless its `on` is the host identity (then
  an `alias`).
- **`ExtensionJoin` carries `parentKey`** (the host column the side key references), so A4 can check the extension
  hangs off the base table and that its key is the resource's identity. A lookup's `pk` must be its table's
  primary key or unique (N:1).
- **The base `where` may read joins**: `where: (j) => SQL` over the rendered join columns (`JoinColumns`), which
  makes each join it reads `membership` for every tuple. `serveCollection` walks it at module eval.
- **T2:** column overrides are `(j) => ColumnRef` over `j.base` and the declared joins (`JoinRefs`); an undeclared
  relation is a tsc error, and a ref naming another table's column throws (A4). No production collection used an
  override, so nothing else moved.
- **Found on the way:** `tablePrimary` compared a table-level `primaryKey({ columns: [x] })` declaration's column
  to the table's own by identity; drizzle builds them apart, so such a table's identity route routed by column
  (FULL) in P1. It now resolves by name (entities declare an inline `.primaryKey()`, so no production collection
  was affected).
- **After review:**
  - **The order signature is per tuple.** `orderSignatureOf(row, params)` (runtime seam, every call site passes
    the tuple's params) covers only the columns that tuple orders by, cut from `signatureColumns`. Otherwise a
    value-role write (a playback row under a `title` sort) to a member moved the one per-resource signature
    whenever a joined column was sortable, and cost the tuple an O(window) `windowIdsOf` it did not need.
  - **T2 is typed at the return too:** an override returns `JoinRef<JoinRefs<…>>`, one of the `TypedColumnRef`s
    its `j` offers, so a hand-written `{ from: "base", col: other.x }` is a tsc error, not only an A4 throw. `j`
    offers WIRE columns only: the base source's, and a join's `wireColumns` when it carries them (`ext.join()`
    does), so an extension's server-only timestamps cannot be bound; a cast past the types throws.
  - **A field read through a LEFT join must be nullable** (its schema accepts `null`), checked at module eval.
  - **A joined `withWire` column is encoded:** the codec is looked up by the table's own column, not the alias
    proxy the SQL renders (which the codec map never holds), and such a field is refused as filterable like a
    base one.
  - **Route columns read the projection:** a spec with no `select` projects every column, so its routes list
    them all (the exact-columns rule read `select` only, which the changed-columns gate would have turned into
    dropped updates).
- **Tests:** `network/live/server/internal/serve-collection-joins.test.ts` (routes, roles, SQL, the provenance
  property over random params for full / scoped / ids / point / groups — the relations each statement joins
  equal `usesOf`, every `"rel"."col"` it references is joined, and every join it makes is referenced outside
  its own condition, required, or an ancestor of one that is (the ids query exempt: it joins the whole
  read-set); A4 / T2; a joined `withWire` column; server-only and non-nullable joined fields);
  `serve-collection-oracle.test.ts` (Verification §3, the extension case: a random host / extension workload
  through the real triggers, listener and `routeChange` into the server-core runtime; every view converges to a
  fresh FULL load, every refill is within the changed hosts or a window backfill entrant, a grouping that does
  not read the extension never loads for an extension write, no subscribed window or point tuple is ever
  reloaded FULL, and value-role skips occur); `compile-window.test.ts` (join guards, exact columns, a
  select-all's route columns, the per-tuple signature); `define-extension-join.test.ts` (`ext.join`, its wire
  columns).
- **Until P3: an extension row whose key changes.** The alias route reads the PK-only trigger's ids, which carry
  the NEW key only, so an UPDATE of a side row's `parent_id` refills the new host and leaves the old one showing
  the side values it no longer has, until its next FULL (P1 routed such tables FULL on the legacy path). The
  same holds for an identity route when a host's own PK changes. Extensions are keyed by their parent (an
  `upsert` never rewrites the key, and the FK cascades a parent delete), so no production write does this; P3's
  old ∪ new ids close it.

### P2 — DataView live-window adapter (design)

A server-delegated DataView today reads `fetchPage(sort, filter, cursor, limit)` and refetches every loaded
page whenever a `changeTick` moves (`data-view/web/internal/use-server-data-source.ts`). The adapter replaces
that pair with a `network/live` collection: the view's sort, filter, search and group-by lower onto window
params, and the rows stay live through the routed runtime. `dataSource` (fetchPage) stays for the lists that
have not moved yet; the two are exclusive props.

*Revised 2026-09-30 after a design critique (22 findings); the disposition of each is at the end of this
section.*

#### What a list author writes

```ts
// core/ — once, next to the collection
export const mailThreads = liveCollection("mail.threads", {
  row: MailThreadSchema, id: "id",
  filterable: { accountId: liveText(), subject: liveText(), snippet: liveText(), lastMessageAt: liveInstant(),
                labelIds: liveStringArray(), unread: liveBoolean(), /* … */ messageCount: liveNumber() },
  sortable: ["subject", "lastMessageAt", "messageCount"],
  default: { orderBy: [["lastMessageAt", "desc"]], limit: 100 }, maxLimit: 500,
  scroll: true,                       // may back a scroll: requires maxLimit ≥ 3 · default.limit (declaration throw)
});
export const mailThreadsSource = liveDataSource(mailThreads, { searchable: ["subject", "snippet"] });

// web/
<DataView<MailThread> storageKey={MAIL_THREADS_VIEW} fields={fields} views={["list"]}
                      source={mailThreadsSource.scoped({ where: { accountId: account.id } })}
                      selectedRowId={…} onRowActivate={…} />
// a field whose id is not its column names it:
{ id: "labels", column: mailThreads.column("labelIds"), values: (t) => t.labelIds, … }
```

- `liveDataSource(collection, { searchable })` lives in `data-view/core`. It takes only a collection declared
  `scroll: true` (type), and `searchable` is typed to the collection's `text`-domain filterable columns.
- **The `scroll` flag is where the scroll policy is checked.** `liveCollection` validates
  `maxLimit ≥ 3 · default.limit` at declaration when `scroll: true`. Below `3H` the merge threshold
  `maxLimit − 2H` (below) is ≤ H and merging means nothing.
- **`source.scoped({ where })`** ANDs a base filter into every tuple the source mints, before the view's own filter.
  Its columns must be filterable (they are routed like any other column). It is how a surface states scope as
  data (mail's account, below). No `FieldDef` lowers to a scope-only column, so the user's filter control
  cannot name or widen it.
- **`DataViewProps` becomes a union over the data origin**, so a stand-in cannot be spelled:
  - `{ rows; loading?; rowKey }`: in memory;
  - `{ dataSource; rowKey; rows?: never }`: fetchPage;
  - `{ source; rows?: never; loading?: never; rowKey?: never; hierarchy?: never; manualOrder?: never;
    searchAccessor?: never }`: live.
    - The row key is the collection's `id`, so it cannot disagree with the id the runtime keys deltas by. The
      `rowKey` surface coordinate threaded to field extensions is `(row) => row[collection.id]`.
    - `hierarchy` is refused because a tree over a partial, paged set orphans children, and `hasChildren` reads
      `props.rows`. `manualOrder` is refused because a consumer's rank would reorder server-sorted segments.
      `searchAccessor` is refused because search is `searchable` now. The contributed `rowOrderEnabled` also
      requires `source == null`.
  - `source` has type `LiveDataSource<TRow>`, whose `TRow` is the collection's row type, so a mismatched
    `DataView<T>` is a tsc error.
  - **The bundle types stay unions.** `DataViewSourceBundle` (`data-view/web/internal/body-types.ts`) is
    `Omit<DataViewProps, …>` today, and `Omit` is not distributive: over the union it would make
    `{ source, rows }` legal again on the `MergedDataView` path. It becomes
    `DistributiveOmit<T, K> = T extends unknown ? Omit<T, K> : never`. `DataViewBodyProps` changes from an
    `interface … extends` (which cannot extend a union) to a type intersection over that union.
- **`FieldDef.column?: LiveColumnRef`** is the field-id ↔ column mapping. Only `collection.column(name)` and a
  contributed-column handle's `.column(name)` (below) mint one, typed to the declared filterable ∪ sortable
  names. A field without it lowers under its own `id`. Field ids stay the persisted vocabulary (saved views say
  `labels`, `added`), so nothing in config migrates. Mappings:
  - mail: `labels → labelIds`;
  - Sonata: `duration → durationSec` and `added → createdAt`.
- **A ref carries its collection.** A `LiveColumnRef` holds its collection's key as data, and a contributed ref
  also holds its handle. At mount, the adapter asserts every field's ref names the `source`'s collection.
  - A field with `column` on an in-memory or fetchPage DataView throws at mount, because it would be silently
    ignored there.
  - The type rung is not taken. Branding the ref with the collection would need a collection parameter on
    `FieldDef<TRow>`, which every field contributor in the repo spells. Row-type branding is already a tsc
    check, and the mount assert covers the case of the same row type on two collections.

#### Lowering (`data-view/web/internal/live-source.ts`, one hook `useLiveSource`)

The field → column resolution runs once per render over the merged `fields`.

- **An offered field must resolve.** A field marked `sortable` whose column is not throws, and so does a
  filterable field whose domain ≠ the column's domain.
- **The check runs where the field is declared.** For a `DataViewSlots.FieldExtension` contributor (Sonata's
  `Library.Fields` come from three other plugins), it runs inside that contributor's `render(fields)`, which
  `renderIsolated` already wraps in the contribution's error boundary
  (`data-view/web/internal/field-extensions.tsx`). One bad contributor then crashes only its own fields, and
  the error names its plugin. The host's own `fields` are checked in `DataViewBody`.
- **A saved rule whose field does not resolve is a state, never a silent drop:**
  - **While the deferred plugin tier is still loading** (`useDeferredLoadState().deferredComplete === false`,
    the signal `layouts/route-fallback` already reads), the rule is **pending**, and the view shows the
    loading skeleton. A contributor such as playback-history can load in the deferred tier, so on first paint
    a "Most played" view's `playCount` rule is not yet resolvable. That means not known yet, not unavailable.
  - **Once the tiers have settled**, it is the error arm: `UnavailableSortRuleError` or
    `UnavailableFilterRuleError`.

| DataView | Window | Undeclared or mismatched |
|---|---|---|
| Filter `FilterGroup` | `lowerServerFilter` (unchanged: it lowers over field ids and reads the clock), then a rename of every clause's field id → column, then ANDed after the source's `scoped` base into the window `where`. | The Filter control offers only fields whose column is filterable. A saved rule on any other field follows the pending/error rule above. |
| Search box | Debounced 200 ms, lowered, then `or(contains(col, q) …)` over `searchable`, ANDed into `where` | — (tsc) |
| Sort `SortRule[]` | `orderBy: [[column, dir] …]`; an empty sort takes the collection default | The sort control offers only fields whose column is sortable. A saved rule on any other field follows the pending/error rule above; fetchPage's `buildSortKeys` drops it silently. |
| Group-by | See "Group-by under a live source" below. | — |
| Relative dates | `useServerFilter`'s clock is kept: a new `where` at local midnight | — |

- Duplicate `orderBy` columns (the group prepend, or two fields on one column) are removed before encoding,
  because the codec throws on a duplicate.
- The DataView's `effectiveState` substitution is unchanged: the rows come back already filtered and sorted,
  so `useFlatRows` passes them through.
- **The codec needs no contributed-column registry.** A contributed ref carries its handle, and the handle
  carries its columns' domains and sortability. The adapter hands the codec the handles its query references,
  so encoding validates against them. There is no module-eval registry, and nothing is empty before a tier
  loads.
- **Search is debounced.** `setQuery` is undebounced today. Under a live source, each keystroke would mint,
  subscribe to, FULL-load (an ILIKE scan) and release a tuple. The adapter lowers a 200 ms-debounced copy of
  the query. A query change caused by search alone is a **keep-previous handoff**: the previous scroll stays
  rendered until the new head settles, using the scroll's own handoff (below). Any other query change (sort,
  filter, group, the midnight clock) starts a new scroll whose head is pending, which shows the skeleton.

#### Group-by under a live source

Two facts constrain this:
- Sections are ordered by `GroupBucket.order`, and that order is not monotone in SQL order in general. An
  `enum` bucket's order is its `options` index, but SQL orders the stored value. The identity grouping orders
  by `compareValues` (`localeCompare`), but SQL uses the database collation.
- A bucketed grouping (a date by day) is not a function SQL can order by without a per-field-type bucket
  expression. That would make data-view name field types.

The rule:
- **`FieldGrouping` gains `oneBucketPerValue?: true`.** It is declared by the grouping, never inferred from the
  field type. The identity grouping (`identity-grouping.ts`) and an `enum` options grouping declare it.
- **A one-bucket-per-value grouping over a sortable column:** `[groupColumn, groupDir]` is prepended to
  `orderBy` unless it already leads.
  - Under a live source, **sections are ordered by first appearance in row order** (the existing `seq`), not
    by `order`. The rows arrive sorted by the column, so first appearance is SQL order.
  - "None" (NULL) still trails, which matches the keyset's NULLS LAST in both directions.
  - A section followed by another loaded section is complete. A later page can only add sections after the
    loaded tail.
  - Behaviour change: an enum grouping's sections read in stored-value order, not options order, as its sort
    does.
- **Any other grouping (bucketed, or an unsortable column):** nothing is prepended, so the user's sort holds
  inside each section. Sections partition the loaded rows and are ordered by bucket `order`, as in memory. A
  later page can add rows to any section.

**`DataViewSection.count` becomes a type:** `{ kind: "exact"; n } | { kind: "atLeast"; n }`. It is rendered by
one formatter (`n+`), so a view cannot print a lower bound as a total. It is derived from loaded rows only:
- in memory: always `exact`;
- live or fetchPage: `exact` when the scroll's gap-free prefix is exhausted (below), or, under a
  one-bucket-per-value prepend, when a later section has started in the loaded prefix. Otherwise it is
  `atLeast(loaded)`.

This fixes a lie fetchPage lists tell today: they print a loaded count as a total. **`:groups` totals are not
read in P2.** Neither proof list needs them: mail does not group by default, and Sonata's grouped view loads
fully, so it is `exact` by exhaustion. They land with the first list that does need them, which renders
`max(count, loaded)` because a groups flush and a rows flush can disagree. `useLive(c, null)` (the skipped
collection read) is therefore not added either.

#### Infinite scroll and paging past `maxLimit`: the segmented scroll (decision)

> **Superseded (2026-10-09):** the segmented scroll (`useLiveScroll`, `shared/scroll-plan.ts`, every loaded segment live, the 16-segment cap) is replaced by live key-range pages (`useLiveCollectionPages`, `shared/page-plan.ts`) whose liveness follows the viewport — see `research/2026-10-09-global-live-key-range-pages-v2.md`.

A window grows only to `maxLimit`, and that bound is what keeps each tuple's `windowIdsOf` and sub-ack at
O(window). A deep scroll is therefore **several windows, each ≤ `maxLimit`, that partition the order by
cuts**, and **every loaded segment stays live**.

**Landing order (risk).** The segmented scroll accounts for most of this section's risk, so it lands in two
steps behind one result type:
1. **`useLiveScroll` at K = 1 lands first.** It is one segment `(−∞, +∞)` that grows by H to `maxLimit`, then
   says `truncated`. The props, lowering and footer are the same as with segments. The conversions build on
   it and do not wait for segments.
2. **Segments are added behind it**, with no consumer change.

**The invariant: the rendered rows are a gap-free prefix of the order.** Everything below either keeps it or
re-establishes it within one handoff:
- `exhausted`, `canGrow`, section counts and the empty state are computed over the **gap-free prefix**: the
  segments up to and including the first one that is full and bounded (`rows == limit` and `until ≠ +∞`,
  which may hide rows before its `until`).
- Segments after that one keep rendering while the growth or split that re-establishes the invariant is in
  flight. This is a transient gap lasting one handoff, the same class as assembly's one-flush absence. They
  count towards nothing until the prefix reaches past them again.

**Window bounds (codec + compiler).**
- The window params gain two optional additive keys:
  - `after`: an exclusive lower cut;
  - `until`: an inclusive upper cut.
  Both are absent by default, so the default tuple stays byte-identical.
- **A cut is a server-minted row key, used verbatim.** A tuple of a collection declared `scroll: true` projects
  one reserved window-only column, `$key`.
  - `$key` is the canonical JSON of the row's order-column values as exact Postgres text (`col::text`), then
    the id (omitted when the order already ends with it).
  - The text form round-trips exactly: `timestamptz` with its offset and µs precision, `numeric`, and `float8`
    (shortest-exact output since PG 12).
  - This is why the client never extracts a cut from its decoded row. `pg` parses a `timestamptz` into a
    millisecond `Date`, and under `desc` every row in `(cut_ms, true_t)` would join S1. With more than H rows
    in one millisecond, S1 would be full again at once, the next split would mint the same cut, and the
    splitting would never end.
  - There is also no second key-derivation on the client, and no contributed-column plumbing for cuts.
    `compile-window`'s key list is the only derivation.
- **`$key` is bounded.** A `$key` over 1 KiB (a text sort such as `subject` or `title` carries user text) is
  projected as `null`. A split whose cut row has a `null` key does not split. It collapses at that segment (the
  cap rule below) with `truncated: true`, reason `"sort key too long to page past"`. The tuple params and the
  WebSocket subscribe message therefore stay bounded.
- **`$key` is not part of the row.** The window's wire schema is the row schema plus `$key` (a declared
  window-only passthrough key, so zod does not strip it). The scroll splits it off into a per-segment
  `Map<id, key>` before rows reach the DataView, so `TRow` never has it and `:rows` points never project it.
  It is derived from projected order columns, so it rides every delta of its row with no signature change.
- **Decode is strict:** a cut must parse as a key of exactly the tuple's `orderBy` arity (+ id).
- **Cuts compile on the order side, not the `where` side.** `compileWindowQuery` renders
  `seekPredicate(keys, after)` and a new `primitives/keyset.atOrBeforePredicate(keys, until)` over the tuple's
  rendered order columns, each operand cast back with `$n::<column type>`, for every shape (full, scoped, ids).
  - They are ANDed **after** the tuple `where` has been checked against the `whereReads` universe, and are
    checked against the tuple's order columns instead. An order column that is sortable but not filterable
    (Sonata `durationSec`, `createdAt`) therefore does not trip the universe throw.
  - `atOrBeforePredicate` is its own NULLS-LAST predicate, not `NOT seek`, whose NULL comparisons could
    exclude rows. Key `nullable` comes from the column's `notNull`, and a LEFT-joined column is nullable
    unless it is a defaulted extension column (below).
  - Cuts read only order columns, which are already in the route columns and the per-tuple signature, so
    `usesOf`, roles and routes are unchanged.

**The scroll (`network/live/web`: `useLiveScroll(c, query | null)`).** The client state is an ordered list of
segments `{ after, until, limit }` whose ranges tile the order. H is `default.limit`, and M is `maxLimit`
(≥ 3H).

| Operation | When | Result |
|---|---|---|
| Start | new scroll | one segment `(−∞, +∞)` at limit H |
| Grow | `loadMore()` on a tail with `rows == limit < M`; or a **bounded** segment with `rows == limit < M` (it may hide rows) | that segment at `min(M, limit + H)` |
| Split | a segment with `rows == limit == M`: the tail on `loadMore()`, or a bounded segment as soon as it fills | cut = `$key` of row `M − H`. `S1 = (a, cut]` at M (H rows of headroom). `S2 = (cut, b]` at 2H: the H known rows plus H more, which is the `loadMore` for a tail. |
| Merge | two adjacent settled segments whose rows sum to ≤ `M − 2H` (the hysteresis against the split) | one segment `(a₁, b₂]` at `rows + H` (≤ M − H) |
| Empty fold | a settled segment with 0 rows | merged at once into its predecessor (its successor if it is the head), whatever the threshold |
| Progress guard | a split whose S1 would not be smaller than the segment it replaces (`cut` = the segment's `until`, or a `null` key) | no split: collapse and `truncated`, reported loudly (a `clientLog` line), never a retry of the same cut |

- **Bound on K.** After merging, every adjacent pair holds more than `T = M − 2H` rows, so
  `K ≤ 2⌈rows / T⌉ + 1`. For mail (H 100, M 500, T 300), 1,000 loaded rows need at most 9 segments.
- **Cap and collapse.** A scroll holds at most `MAX_SCROLL_SEGMENTS = 16` segments. When segment j must split
  and cannot (K is at the cap, or the progress guard fires):
  - every segment after j is dropped;
  - j is replaced by an unbounded tail `(aⱼ, +∞)` at M.

  The rendered rows are then again a gap-free prefix, ending at j's first M rows. `canGrow` stays true, and
  paging past it splits the tail again with room freed.
  - `truncated: true` holds only when the tail itself is at M and cannot split: j is the last segment at the
    cap, or its key is `null`. The footer then says so ("Showing the first N — narrow the filter").
  - This is what fixes the head that keeps filling. Under mail's `lastMessageAt desc`, every new message
    enters the head, so the head splits every H new messages. Merges absorb most of the new segments, but K
    creeps up over a long session. At the cap, the collapse gives up the rows below the full segment rather
    than hiding rows inside it.
- **Handoff.**
  - Grow, split, merge and collapse each mint new tuples.
  - The replaced segments stay subscribed and rendered until every replacement has settled, as `useLive`'s
    grow does, so the result never flips back to `pending`.
  - **A replacement that errors** keeps the old segment's rows on screen and sets that segment's
    `segmentError`. The prefix rule above keeps counting from the old segment, so while it stands, a gap it
    would have closed is visible as the error, never silent.
- **Assembly.** Segments are concatenated in order and **deduped by id, first occurrence wins**. A row moving
  between two segments arrives as an exit in one tuple and an entry in the other. Those two frames can land in
  different flushes, so a transient duplicate is dropped, and a transient absence lasts one flush.
- **Result type:**

  ```ts
  { pending: true; error }
  | { pending: false; rows; exhausted; canGrow; growing; loadMore; truncated: false | { reason };
      segmentErrors: readonly { afterRowId: string | null; error: Error; retry(): void }[] }
  ```

  A failed segment's last server-vouched rows stay on screen. `retry` re-subscribes **that** segment (or
  re-mints its failed replacement). It is never `loadMore`.
- **Plumbing.**
  - The number of segments changes over time, so the hook reads them through a new **`live-state` plural
    `useResources(descriptor, paramsList)`**.
  - It is built on `useQueries`, with the same per-tuple semantics as `useResource`: observe/unobserve
    refcount, cold-start prime and pending-mount accounting. It does not take `select` or `gate`.
  - `useResource`'s query options and per-tuple effects are factored into shared internals, so the two hooks
    stay on one code path.
  - K = 1 (landing step 1) reads through `useLive`, so `useResources` arrives with segments.

**Why every segment is live, not only the head.** A frozen tail keeps showing rows that no longer match (a
thread marked read stays under Unread) and hides new ones, which is exactly the staleness the tick existed to
heal.

**Why the cost stays bounded.** Take a routed change to the host table with K subscribed segments:
- **Scoped refills:** K of them, each `id = ANY($changed) AND where AND cuts`, an indexed statement. The
  identity route reaches every tracked tuple until P4's `changed` gate.
- **`windowIdsOf`:** at most 2 runs of O(M). A row can only leave the one range it was in and enter the one it
  now falls in; a refill that finds nothing is neither.
- **Value-role side-table write:** it loads only in the segment holding the host (P2's value-role
  intersection), and no statement runs for any other segment.
- **Compared with today:** the tick refetch is O(loaded rows) per change, and K ≤ 16.
- **Grow, split and merge:** each costs one or two bounded loads, amortised over H inserts into one range.

**P4 follow-on (recorded, not built here):** once `changed` exists, the identity route treats a host U whose
changed columns miss the tuple's `where` / `order` columns as value-role. Such a U then reaches only the
segment holding it, with no statements on the other K−1.

**DataView wiring.**
- **`useInfiniteScroll` gains a separate `retry`.** Today its `retry` *is* `fetchNextPage`
  (`cursor-pagination/web/internal/use-infinite-scroll.ts`). The new option defaults to `fetchNextPage`, so
  existing callers keep their behaviour.
- The adapter passes:
  - `hasNextPage: canGrow && !holdPaging(rows)`;
  - `isFetchingNextPage: growing`;
  - `isFetchNextPageError`: true **only for an error on the tail**, so a failed middle segment does not
    freeze paging at the bottom;
  - `fetchNextPage: loadMore`;
  - `retry`: the tail's own `retry`.
- **A middle segment's error is not in the footer.** It renders as one notice in the body above the rows, under
  the sticky toolbar ("Rows after ‹row› could not refresh — Retry"), naming its boundary and calling that
  segment's `retry`.
  - A notice between two rows would need a non-row entry kind in every view (list, table, gallery, icons).
    That is not worth it for a rare state whose rows stay on screen.
- `holdPaging` (the fold rule) is unchanged. `InfiniteScrollFooter` gains the `truncated` line with its reason.

#### Contributed columns, and the custom-columns seam

The Sonata proof sorts and filters by columns that **other plugins** contribute: `Library.Fields` from
playback-history, midi and midi/folders. That set is open, so the library cannot name them. One seam serves
both static contributors (now) and custom columns (P3).

- **Core (browser-safe), in the contributor:** a handle, and nothing registered.
  ```ts
  export const playbackColumns = liveColumns(songLibrary, "playback", {
    row: z.object({ playCount: z.number(), lastPlayedAt: z.date().nullable() }),
    filterable, sortable,
  })
  ```
  - Wire names are `<name>.<field>`. A base column name cannot contain `.`, which the codec checks.
  - The handle carries its domains and sortability, and `.column(field)` mints refs that carry the handle.
    Encoding validates against the handles a query references (see Lowering), so there is no module-eval
    registry, and no ordering between the contributor's core and the codec.
  - The base collection opts in with `contributed: true`.
- **Rows: `$columns` is a declared part of the row type.**
  - A `contributed` collection's row type is `Row & { $columns: ContributedColumns }`. `ContributedColumns`
    is `Readonly<Record<string, Readonly<Record<string, unknown>>>>`, opaque to everyone but the handles.
  - `$columns` is a declared passthrough key: the row schema has it (so zod does not strip it), the projection
    lists it (`rowKeys` plus `$columns`), and the wire codec encodes it.
  - **Server side,** each contributed column is projected flat under its wire name and folded in JS into
    `$columns[name][field]`, with that column's `withWire` codec applied, exactly as a base `withWire` column
    is encoded. A `Date` then crosses the wire the way a base one does.
  - **Client side,** the handle's `read(row)` parses its own slice with its zod schema once per row object (a
    WeakMap) and returns it typed. For example, `value: (s) => playbackColumns.read(s).lastPlayedAt`. `Song`
    as the DataView's `TRow` is `SongRow & { $columns }`, so there is no untyped hidden property.
  - **`:rows` points project the contributed columns too.** A point compiles through the same plan, with the
    contributors' joins value-role. `useLiveRow(songLibrary, id)` therefore returns the same row shape as a
    window row, and one type means one shape.
  - **Deltas and signature.** `$columns` is part of the encoded row the runtime diffs, so a play changes the
    row object. It enters a tuple's order signature exactly when that tuple orders by a contributed column,
    under the per-tuple signature rule of the P2 routing half.
- **Server, in the contributor: a contribution, not a registry.**
  ```ts
  contributions: [LiveColumns.Serve(serveColumns(playbackColumns, {
    join: songPlayback.join("playback"), columns: { lastPlayedAt: (j) => … } }))]
  ```
  - It is typed the same way as `serveCollection`'s overrides (T2), and A4 applies.
  - Server contributions are collected by `collectContributions`, in `bootPluginGraph`
    (`server-core/shared/boot-stages.ts`). That runs after every server module has loaded and before the
    `onReadyBlocking` barrier where the change feed rebuilds triggers, which is exactly when the base
    collection must compile. So the contributor needs no module-eval registration and no import order.
- **Defaulted extension columns are never NULL (rung 1).**
  - Entity-extension semantics say an extension row that does not exist means its declared defaults.
    `ext.join()` renders a column that declares a literal `default` in the extension's meta as
    `COALESCE(alias.col, <default>)`: playback's `playCount` (0), and midi's `sourceMissing` (false).
  - Such a column is non-nullable in the join's wire columns and keyset keys. This relaxes the "a
    LEFT-joined field must be nullable" rule for exactly those columns.
  - A never-played song therefore has `playCount = 0` in SQL, as its field's `?? 0` says today. The authored
    "Unplayed" preset (`playCount = 0`, `config/apps/sonata/library/sonata.library.jsonc`), a saved rule, and
    the "Most played" sort all keep their meaning, and no config migrates. A "File is false" rule keeps every
    non-MIDI song, as `?? false` does today.
  - Provenance is unchanged: the `COALESCE` still references the alias column.
  - An undefaulted column (`lastPlayedAt`) stays nullable.
- **Deferred bind (framework, `resource-runtime` + `server-core`).**
  - The base `serveCollection` of a `contributed` collection cannot compile at module eval, because its
    contributors are only known once contributions are collected.
  - It creates its three resources **deferred**: key, preload and `Resource.Declare` exist at module eval,
    and spec and routes do not yet.
  - A new boot step, `bindDeferredResources()`, runs in `bootPluginGraph` right after `collectContributions`
    and before `assertPreloadedResourcesDeclared` and the ready barrier, in both modes. It compiles each
    deferred resource with the `LiveColumns.Serve` contributions naming its collection, and the runtime adds
    their routes to its index at bind.
  - Boot throws on:
    - an unbound deferred resource;
    - a `LiveColumns.Serve` naming a collection not declared `contributed`;
    - two contributions with one `name`.
  - Serving or routing a deferred entry before bind throws.
  - **A web handle with no server half** fails the strict decode at first use (a sub-error naming the
    column). The check `live:contributed-columns-served` makes it a check error first: every `liveColumns(`
    handle is referenced by a `serveColumns(` in its plugin's server.
  - **Why the bind step stays.** A resource's spec and routes must exist before the change feed rebuilds
    triggers (A3 in P3 reads the route layout). Contributions are the earliest point at which the full
    contributor set is known. The step is the one piece of new framework surface; the registry the earlier
    draft had is gone.
- **Custom columns (P3, same seam).** Custom-columns becomes a **surface-scoped dynamic** contributor
  (`custom.<columnId>`).
  - Its vocabulary is per surface: the column defs in the data-view config.
  - A tuple that references one carries an extra `surface` param (`storageKey`).
  - The compiler joins a `keyed-side` spec per referenced column. The route is one `alias(row_key)` on
    `data_view_custom_values`, with `rows: { data_view_id: surface }` and `match: { column_id: referenced }`,
    and `recomputeOn` the surface's config value.
  - The client validates a dynamic column against the domain its field's operator set lowers over. The
    server validates it strictly against the surface's current defs (`resolveFieldValueTextCast`, as the
    augmentor does today).
  - `CustomColumnFieldExtension` sets `column` on every cc field.
  - **Until P3:** a live source offers no cc field for sort or filter. cc values still display, from
    `customColumnValues`. A saved cc rule is the `Unavailable…RuleError` arm, after the tiers settle.
  - Whether P3 projects only the referenced cc columns or all of the surface's (which would retire
    `customColumnValues` for live surfaces) is decided there, on measured join cost.

#### Loading, errors, selection

- **Pending:** the head segment is pending, or a saved rule is pending on the deferred tier ⇒ DataView's
  loading skeleton, never the empty state.
- **Empty state:** every segment is settled and the total is 0. "A settled head with 0 rows" is not enough:
  every row of `(−∞, cut₁]` may have been deleted while later segments still hold rows. The empty fold then
  merges the empty head away within one handoff.
- **Errors:**
  - a head error, or a sort or filter rule that is unavailable after the tiers have settled, renders in place
    of the view (the existing `server.error` branch);
  - a tail error is the footer's Retry over the rows already shown;
  - a middle segment's error is the body notice (see DataView wiring).
- **Query change:** a search-only change is the keep-previous handoff; any other change shows the skeleton
  (see Lowering).
- **Selection:**
  - `selectedRowId` highlights by id in whichever segment holds the row. React keys are ids, so a row moving
    between segments or through a handoff re-renders without remounting.
  - A selected row that is not loaded, or that left the window, is simply not shown. The reading pane keeps
    it through its own point read, and nothing auto-pages to it.
  - The fold keeps the selected row.

#### Conversions in P2, and what each one deletes

**Every remaining fetchPage consumer drops `rows={[]}` now**, not only the converted lists, because the props
union makes `rows?: never` on the fetchPage arm:
- all-conversations (`conversations/plugins/all-conversations/web/panes.tsx`);
- runs (`runs/web/components/runs-data-view.tsx`);
- reports (`debug/plugins/reports/web/components/reports-view.tsx`);
- events (`apps/plugins/events/plugins/event-list/web/panes.tsx`);
- release history (`…/compositions/plugins/release/web/components/release-history-section.tsx`);
- deploy history (`deploy/plugins/deploy-history/web/components/deploy-history-section.tsx`).

`deployments-section.tsx`'s `rows={[]} loading` is an in-memory loading state, and it stays.

**Mail threads** (`mail/plugins/threads`):
- It becomes `mailThreads` + `serveCollection(mailThreads, { from: mailThreads entity })`, a single table with
  identity routes only.
- **The account scope is data, not a subquery.**
  - The earlier draft dropped the predicate on the assumption that the app is single-account. That is false:
    `sync/server/internal/bootstrap.ts` `findOrCreateAccount` keys accounts by email, and nothing deletes
    from `mail_accounts`. Connecting a second Google account adds a second row, and both accounts' threads
    stay.
  - The current `resolveMailAccountId` (`mail-core/server/internal/account.ts`) is `LIMIT 1` with no
    `ORDER BY`, so which account is shown is arbitrary today.
  - A required `lookup` cannot say "the one account": it is an N:1 FK join that matches every thread.
  - The fix:
    - `mail-core` gains a live value `mailAccount`: the connected account, `{ id, email } | null`, served
      over `mail_accounts ORDER BY connected_at, id LIMIT 1`. It is one row, not collection-shaped.
    - `resolveMailAccountId` takes the same `ORDER BY`, so "the account" has one definition.
    - The threads pane reads `mailAccount`: pending shows the skeleton, `null` shows the existing
      not-connected landing, and an id gives
      `source={mailThreadsSource.scoped({ where: { accountId: id } })}`.
  - `accountId` is a filterable column routed like any other. Multi-account later becomes a view filter on it.
  - `where.test.ts`'s guarantee that "a request naming `accountId` cannot widen the scope" becomes a guarantee
    that no field lowers to it. Under the single-instance ADR, the client choosing its own scope is not a
    security boundary.
  - Behaviour change: with two accounts, the list shows the earliest-connected one deterministically, not an
    arbitrary one.
- **Deleted:**
  - `mail-threads-revision` (core descriptor, server loader, and its declare);
  - the `queryThreads` endpoint, `handle-query.ts`, `where.ts` (+ test) and `column-map.ts`;
  - `MAIL_THREAD_FILTERABLE` / `SEARCHABLE` (now `mailThreads` / `mailThreadsSource`);
  - the `nullable` flags in `MAIL_THREAD_FIELDS`, since keyset nullability now comes from the column;
  - the `rows={[]}`, `changeTick` and `fetchPage` wiring;
  - these files' entries in the `no-legacy-resource-spelling` ignore list.
- **Kept:** `e2e/mailbox-tabs-verify.ts`, which is re-run.
- **Mail custom columns:** a cc filter on the threads list is already broken today: `handle-query` never runs
  the augmentor and strict-decodes, so it returns 400. It becomes the named error arm, which is no
  regression.

**Sonata library** (`sonata/plugins/library`, `playback-history`, `sources/plugins/midi` (+`folders`)):
- `songLibrary = liveCollection("sonata.songs", { …, contributed: true, scroll: true })`, served from
  `_songs`, with H 100 and M 500.
- Playback and midi each declare a `liveColumns` handle in core and a `LiveColumns.Serve(serveColumns(…))`
  contribution over their extension's `.join()`. Folders' `sourceMissing` field reads midi's handle, which is
  midi's public core.
- The table and gallery DataView takes `source={songLibrarySource}` (`searchable: ["title","composer"]`), and
  its fields gain `column`.
- **The other readers of the `songs` value move:**
  - `useCurrentSong`, `useSongTitle` and `useSonataPlayerResolve` → `useLiveRow(songLibrary, id)`, whose
    rows carry `$columns`;
  - the onboarding "no songs" check → `useLive(songLibrary, { limit: 1 })` settled with 0 rows.
- **Deleted:**
  - the values `sonata-songs`, `sonata-playback-history` and `sonata-song-midi`, with their `unbounded`
    reasons and serves;
  - `usePlaybackHistoryMap` and `useSongMidiMap`, with their pending → empty-map collapses;
  - `playback-history/shared/resources.ts`.
- **Behaviour changes to state in the as-landed notes:**
  - Nulls sort last in both directions (the keyset rule). This now affects only undefaulted columns, such as
    `lastPlayedAt`.
  - An enum sort (`source`) is by stored value, not option order, and so are the cards view's `source`
    sections (group-by rule above).
  - **Accepted regression until P3:** a user-defined custom column on the library cannot be sorted or
    filtered (the `Unavailable…RuleError` arm); it still displays. The authored config declares none
    (`sonata.library.origin.jsonc`: `"customColumns": []`). Keeping Sonata in memory until P3 would avoid it,
    but would leave P2's joined-column proof unexercised on a real list. The user's P2 decision asks for the
    proof lists to be converted.

**Later lists on the same adapter:**
- release history and deploy history: P3, with custom columns;
- events: P4, with the `event_sources` lookup;
- conversations, runs and reports: the follow-up task.
- When the last of them moves, `ServerDataSourceSpec`, `useServerDataSource`, `changeTick` and
  `server-query`'s HTTP augmentor path are deleted.

#### Build order and tests

K = 1 first; the conversions do not wait for segments.

1. **`useLiveScroll` at K = 1** (jsdom, fake notifications):
   - grow by H to M, then `truncated`;
   - the grow handoff is never pending;
   - a tail error gives its own `retry`, which is not `loadMore`.
   - `useInfiniteScroll`'s separate `retry`, with existing callers unchanged.
2. **DataView `source`.**
   - tsc (`@ts-expect-error`) rejects:
     - every stand-in on each arm of the props union, including `hierarchy` / `manualOrder` /
       `searchAccessor` on the live arm;
     - `{ source, rows }` and `{ source, rowKey }` through `DataViewSourceBundle` on the `MergedDataView`
       path;
     - `liveDataSource` over a collection not declared `scroll`.
   - `liveCollection({ scroll: true })` throws below `3H`.
   - jsdom:
     - the lowering: rename, `scoped` base, debounced search, dedupe;
     - the one-bucket-per-value prepend with first-appearance section order (an enum whose options order ≠
       stored order);
     - a bucketed grouping neither prepends nor reorders the user's sort;
     - an unresolved saved rule is pending before `deferredComplete` and the error arm after;
     - a mismatched ref (other collection) throws at mount, and a `column` on an in-memory DataView throws;
     - a bad `FieldExtension` contributor is contained by its own boundary and named;
     - `SectionCount` exact/atLeast, including "a later section has started";
     - skeleton vs. empty state;
     - the search-only keep-previous handoff;
     - the footer mapping.
3. **Mail threads conversion.**
   - `mailAccount` value;
   - `./equin build`, then `mailbox-tabs-verify.ts`;
   - the profile check (Verification §7): marking a thread read gives **K scoped refills (one non-empty),
     0 `windowIdsOf`, 0 FULL**. K is 1 until the segments land.
4. **Contributed columns + deferred bind.**
   - `ext.join()` `COALESCE`s defaulted columns (non-nullable wire and keyset), and leaves undefaulted ones
     nullable (`define-extension-join.test.ts`);
   - codec accept/reject against handles, with no registry;
   - `$columns` projected, `withWire`-encoded and folded; a side write changes the row object (delta); `:rows`
     carries it;
   - the boot throws (unbound; `Serve` on an undeclared collection; duplicate name), and the
     `live:contributed-columns-served` check;
   - routes of a contributed join, with value vs. membership role, in `serve-collection-joins.test.ts`.
5. **Sonata conversion** + `sonata/plugins/library/e2e/library-live-sort.ts`:
   - play a song in a second tab and see it move under "Recently played";
   - the "Unplayed" preset still lists never-played songs.
6. **keyset `atOrBeforePredicate`.**
   - Property test (DB, `db-test-fixture`): for random rows and cuts over nullable/non-null asc/desc keys,
     `seek(c)` and `atOrBefore(c)` split the rows exactly, and each agrees with an ORDER BY … NULLS LAST
     reference.
7. **Window bounds + `$key`.**
   - `query-codec.test.ts`: cuts are absent by default (the default tuple is byte-identical), decode is
     strict on arity.
   - `compile-window.test.ts`:
     - cuts appear in full / scoped / ids;
     - a sortable-only order key (`durationSec`) with cuts compiles without tripping the `whereReads` throw;
     - `$key` round-trips `timestamptz` µs, `numeric` and `float8` exactly;
     - a `$key` over 1 KiB is `null`.
   - `serve-collection-joins.test.ts`: the provenance property with cuts.
8. **`useResources`** (jsdom): per-element observe/unobserve on add/remove/reorder; shared refcount with a
   `useResource` on the same tuple.
9. **Segments** (`useLiveScroll`, jsdom):
   - bounded grow, then split at M (with the S2 = 2H limit);
   - merge (limit `rows + H`) and the empty fold;
   - dedup of a row that is in two segments;
   - the progress guard (a `null` or non-shrinking cut);
   - cap → collapse (rows are a gap-free prefix again, `canGrow` stays true), and the tail at the cap →
     `truncated`;
   - a failed replacement keeps its old rows with `segmentError`;
   - a middle segment's error does not stop paging.

   Then, in `serve-collection-oracle.test.ts`, a random scroll of K cut segments under the random workload:
   - at quiescence, the concatenation equals a fresh ordered FULL read (no dup, no gap);
   - no segment reloads FULL;
   - refills stay within the changed hosts;
   - at every flush, the rows counted as the prefix are a prefix of that read;
   - **a head that keeps filling at the cap** (repeated inserts at the order's start with K = 16) still
     satisfies the gap-free prefix invariant at every flush, and ends collapsed rather than hiding rows.

Then `./equin check` and `./equin test` over `keyset`, `live-state`, `network/live`,
`query-resource`, `data-view`, `cursor-pagination`, `entity-extensions`, `resource-runtime`, `server-core`
and the two proof plugins.

#### Critique dispositions (2026-09-30)

All 22 findings were checked against the code. Each is addressed above, or partly dismissed where noted:

1. Full bounded segment at the cap: addressed by the gap-free prefix invariant, bounded grow, and cap →
   collapse; oracle case added.
2. Group prepend: addressed by `oneBucketPerValue` with first-appearance section order; bucketed groupings
   do not prepend.
3. Mail account: addressed by the `mailAccount` value and `source.scoped`; multi-account verified possible
   (`findOrCreateAccount`).
4. NULL extension columns: addressed by `COALESCE` over declared defaults in `ext.join()`; no config
   migration needed.
5. `$columns` plumbing: addressed by the declared passthrough key, typed row, JS fold with `withWire`,
   `:rows` projecting it, and delta and signature rules.
6. Non-distributive `Omit`: addressed by `DistributiveOmit` and a type-intersection `DataViewBodyProps`, with
   merged-path `@ts-expect-error` cases.
7. Props meaningless over a paged source: `hierarchy` / `manualOrder` / `searchAccessor` are `never`, and the
   `rows={[]}` removal is listed for every fetchPage consumer.
8. Not loaded vs unavailable: pending until `deferredComplete`; the codec is registry-free.
9. ms cuts: addressed by the server-minted `$key` and the progress guard.
10. Retry and error placement: separate `retry`; only a tail error freezes paging; a failed replacement is
    `segmentError`. **Partly dismissed:** the notice is placed in the body, not inline, because an inline
    notice needs a non-row entry kind in every view for a rare state whose rows stay visible.
11. Empty state: all segments settled with total 0, plus the empty fold.
12. `:groups` counts: accepted. Counts are `{exact | atLeast}` from loaded rows and prefix exhaustion;
    `:groups` totals and `useLive(c, null)` are deferred.
13. `maxLimit` / limits: `scroll: true` requires `M ≥ 3H` at declaration; every limit is in the operations
    table.
14. Custom columns on Sonata: stated as an accepted regression until P3, with the reason for converting
    anyway.
15. Cuts vs the where universe: cuts compile on the order side; compile test added.
16. Verification claim: now "K scoped refills (one non-empty), 0 `windowIdsOf`, 0 FULL".
17. Search debounce: 200 ms, plus a search-only keep-previous handoff.
18. `LiveColumnRef` collection: the ref carries its collection; mount assert; non-live arms throw. **Partly
    dismissed:** no type-level collection brand, because it would add a collection parameter to every
    `FieldDef` contributor.
19. Contributor crash: validation runs inside the contributor's `render(fields)` boundary and names its
    plugin.
20. Unbounded text cut: `$key` over 1 KiB is `null` → loud truncate.
21. Framework surface: taken. Server columns are a contribution collected before the ready barrier, and the
    module-eval registry is removed; the bind step stays (reason given).
22. Risk: taken. K = 1 lands first behind the same result type, and the conversions do not wait for segments.

#### P2 adapter — as landed (2026-09-30; deviations from the design above)

Everything above but the two proof-list conversions (build-order steps 3 and 5,
the next step) landed; the conversions build on it.

- **Both landing steps in one change.** The segmented scroll landed directly,
  not K = 1 first: the plan (`network/live/shared/scroll-plan.ts`, pure
  data) is shared by the hook and the DB oracle, and `useLiveScroll` reads its
  segments through `useResources` from the start. K = 1's tests (grow to M,
  never pending, a tail error's own retry) run against it.
- **Result type additions.** A `segmentErrors` entry also says `tail: boolean`
  (the footer maps only the tail's error, and a replacement covering the tail
  counts as the tail). `useLiveScroll` takes `{ resetKey }`: a query change under
  the same key is the keep-previous handoff (DataView passes the query minus the
  search), any other starts over. It also accepts a `null` collection (with a
  `null` query) — `DataViewBody` calls it unconditionally, so a surface whose
  origin is not live still has a fixed hook order.
- **COALESCE is derived where joins render**, not in `ext.join()`:
  `compileJoins` coalesces an EXTENSION join's column whose table column carries
  a literal default (drizzle's `.default(value)`, which an extension's meta
  `default` becomes). One definition for every extension join, however built.
  The rendered form is `ReadColumn = PgColumn | SQL`; the expression → column
  map is module-level (`serveCollection` renders through one `JoinPlan`,
  `compileWindowQuery` compiles through another). Join conditions compare the raw
  key, and a static predicate's `j` offers raw columns.
- **Two window-spec seams** the contributed compile needed: `window.limitOf`
  (the descriptor codec cannot decode a tuple naming contributed columns without
  the served handles) and `readField` (the order signature reads a contributed
  column off `$columns`, where `encodeRow` folded it).
- **The erased handle is its own type**: `LiveColumnsDeclaration` (what the
  codec, the server compile and a column ref need); `LiveColumnsHandle<CRow, F,
  S>` extends it. A grouping stays over the collection's own columns (its codec
  takes no handles).
- **Deferred bind**: `bindDeferredResources` binds whatever is pending and may
  run again (a process that boots twice — a test — must not throw); a late
  deferred resource stays unbound, and serving it throws. "A `Serve` naming a
  collection not declared `contributed`" is refused by `liveColumns` itself
  (type + throw); the boot check that remains is "a `Serve` no `serveCollection`
  here compiles", registered through a generic `onDeferredResourcesBound` hook.
- **Also declares `oneBucketPerValue`**: the bool grouping (one section per
  value, `false` before `true` — SQL's order).
- **`DataViewRenderProps` gains `rowsComplete` and `sectionOrder`** (required;
  the host sets them). fetchPage lists now report completeness from their last
  page, so their section counts read `n+` until the list is read to its end —
  the fix the design names.
- **Release history's stand-in** (`dataSource={name ? … : undefined}`, which
  rendered the empty state while the manifest resolved) is gone: the section
  reads the compositions config through `useConfigResult` — its loading state
  while pending, "No composition with id …" for an id the settled config does
  not carry — and only then mounts the fetchPage DataView (a first cut used the
  in-memory `rows: [], loading: true` arm, which spun forever on an unknown id).
- **A failed replacement is SET ASIDE, not held open** (post-review). The
  design's "a replacement that errors keeps the old segment's rows" held the
  change open, which froze paging and every other structural step until a
  retry, while the footer showed neither the sentinel nor the error. The plan
  now moves it to `ScrollState.stalled`: its replacements stay read (a retry,
  or the server answering again, commits it), the scroll is idle again, and
  `reconcile` does not re-mint it while it is still the step to take — any
  other step, or a `loadMore()`, supersedes it. `LiveSegmentError.tail` became
  `blocksPaging` (the tail's own read, a failed page, or — when the scroll can
  neither grow nor is exhausted — every failure, since one of them is what
  holds it), and those go to the footer, so paging never stops silently; e.g. a
  full bounded head whose split fails stops paging by the gap-free-prefix rule,
  and now says so where the list ends. `growing` is false once a page's read
  failed (no spinner beside the error). Each error carries a `key` (its tuple),
  which the body's notices are keyed by.
- **A scroll plan is one collection's** (post-review): its key is the
  collection's key plus the query encoding, and the `resetKey` comparison
  includes the collection, so a surface switching to another collection whose
  query encodes alike starts over. A query changed and changed back before the
  new head settled restores the plan still on screen (no duplicate tuple); the
  hook encodes each segment's tuple once per plan state and reads each tuple
  once.
- **`serveColumns` takes an `ExtensionJoin` only** (type, plus a compile throw
  for a cast): a contributor cannot drop host rows through an INNER lookup or
  change routing roles.
- **`live:contributed-columns-served`** reads whole files with comments and
  strings masked, resolves a serve through the serving file's import aliases,
  ignores test code on both sides, and reports a `liveColumns(` call no `const`
  binds (instead of a one-line regex over exported declarations).
- **The server decodes a window tuple once per params object** (a `WeakMap`):
  `where`, `orderBy`, `window.limitOf` and `scroll.cutsOf` all read it.
- **Deviation kept: a field-extension contributor's crash replaces the surface
  below it, not only its own fields.** The fold renders the rest of the
  surface inside each contributor (through `render(fields)`), so its error
  boundary's fallback stands in for everything after it — for a `validate`
  refusal as for any other crash of the contributor (as before P2). Continuing
  the fold past a refused contributor needs the fold restructured so the
  continuation is a sibling of the contributor, not its child; not done here.
  The refusal is still contained, reported and names its plugin.
- **The live lowering's premise, stated**: a field's `value` IS its column's
  value (`FieldDef.column`'s doc). Filter, sort and the one-bucket-per-value
  group prepend (with its section order and exact counts) all rest on it; a
  field showing a derived value offers none of them under a live source.
- **Public names wait for their consumer.** `liveDataSource` is data-view's
  WEB (`web/internal/live-data-source.ts`; the `LiveDataSource*` types stay in
  core, the props union names them), and it is not on a barrel yet — nor are
  `LiveScrollQuery` / `LiveScrollResult` on live's: plugin-boundaries R13
  refuses a public name only tests import. The first proof conversion exports
  what it imports. The scroll plan is live's `shared/scroll-plan.ts` (web and
  the server-side oracle both read it; a `web/` file may not deep-import its own
  `core/`).
- **The DB oracle** (`serve-collection-scroll-oracle.test.ts`) drives the real
  plan against the real feed and checks the gap-free prefix per statement at
  quiescence (not per flush), plus the head-fill-at-cap case; the per-flush
  prefix invariant is pinned on the pure plan (`scroll-plan.test.ts`).
- **Tests**: `keyset/server/internal/at-or-before.test.ts`;
  `network/live`: `core/internal/query-codec.test.ts`, `shared/scroll-plan.test.ts`,
  `server/internal/{compile-window,scroll-key-roundtrip,serve-collection-joins,serve-collection-contributed,serve-contributed-boot,serve-collection-scroll-oracle}.test.ts`,
  `web/__tests__/{use-live-scroll,use-live}.test.tsx`, `check/index.test.ts`;
  `live-state/web/__tests__/use-resources.test.tsx`;
  `cursor-pagination/web/__tests__/use-infinite-scroll.test.tsx`;
  `data-view`: `web/internal/{live-fields,body-types,use-data-view-sections}.test.ts`,
  `web/__tests__/{live-source,field-extension-check}.test.tsx`;
  `entity-extensions/server/internal/define-extension-join.test.ts`.

#### P2 proof conversions — as landed (2026-09-30)

Build-order steps 3 and 5: both proof lists read the adapter. Deviations and
findings:

- **Mail threads.** `mailThreads` (`mail.threads`, `scroll: true`, H 100 / M
  500, `lastMessageAt desc`) is served from `_mailThreads` with identity routes
  only. The account scope is mail-core's new `mailAccount` value (`{ id, email }
  | null`, the earliest connected; `resolveMailAccountId` runs the same query),
  and the pane mounts `mailThreadsSource.scoped({ where: { accountId } })`:
  pending shows `Loading`, `null` shows the Gmail integration's blocker copy (or
  "first sync has not run" when access is fine) — there was no "not-connected
  landing" inside the threads pane to reuse. `labels → labelIds` rides on the
  shared vocabulary (`MailThreadFieldSpec.column`, typed to the collection's
  columns), which the authored-views test also reads to rename before it
  canonicalizes. Deleted: `mail-threads-revision`, `queryThreads` + its schemas,
  `handle-query.ts`, `where.ts` (+ test), `column-map.ts`,
  `MAIL_THREAD_FILTERABLE` / `SEARCHABLE`, the `nullable` flags, the lint
  ignore-list entries. Nothing outside the plugin used any of them.
- **Sonata library.** `songLibrary` (`sonata.songs`, `scroll` + `contributed`,
  H 100 / M 500, `createdAt desc`) is served from `_songs`; playback-history and
  midi each declare a `liveColumns` handle in a NEW `core/` (`playbackColumns`:
  `playCount` + `lastPlayedAt`, both filterable and sortable; `midiColumns`:
  `trackCount` filterable + sortable, `sourceMissing` filterable) and serve it
  over `ext.join(alias)` in a `LiveColumns.Serve`. The extension shapes moved to
  each plugin's `shared/shape.ts` (the server tables build from them; core cannot
  import shared, and the handles' row schemas differ anyway — `trackCount` is
  nullable through the LEFT join, `playCount` / `sourceMissing` are not thanks to
  the COALESCE). `Song` is now `WithContributedColumns<SongRow>`; the field
  contributors are static field lists reading `handle.read(song)` and binding
  `handle.column(…)` — no hook, nothing to stand in while loading.
  `useCurrentSong` returns `useLiveRow`'s `LiveRowResult` (it had to map a
  `ResourceResult` with a `refetch` a point read does not have); its two readers
  branch on `pending` / `found`. The onboarding probe is `useLive(songLibrary, {
  limit: 1 })`; the DataView owns its own skeleton and errors, so the library's
  error banner is gone. Deleted: `sonata-songs`, `sonata-playback-history`,
  `sonata-song-midi` (values, serves, `unbounded` reasons),
  `usePlaybackHistoryMap`, `useSongMidiMap` (and their pending → empty-map
  collapses), `playback-history/shared/resources.ts`,
  `midi/shared/resources.ts`. Nothing outside the three plugins read them.
- **Public names.** `liveDataSource` is on data-view's web barrel now;
  `LiveScrollQuery` / `LiveScrollResult` stay off live's (no consumer names
  them — the DataView calls `useLiveScroll` internally).
- **E2E, both green against the deploy** (`build: success`):
  - `mail/plugins/threads/e2e/threads-live-verify.ts` seeds three Inbox threads
    for the connected account (a worktree has no mail corpus — `mail_threads` is
    left out of the fork; `e2e/fixture.ts` refuses main and sweeps leftovers),
    then writes the DB directly: a new message moves C to the top (~270 ms), a
    Spam label drops B out of Inbox, marking A read un-bolds it — no reload.
    Profile (§7), marking read: one scoped refill (`ids: 1`), no `windowIdsOf`,
    no FULL; K = 1. The reorder and the exit each cost one `windowIdsOf`.
  - `sonata/plugins/library/e2e/library-live-sort.ts`: under the "Recently
    played" preset (`playback.lastPlayedAt desc`), a play recorded through the
    API moves the song to the top of the open table (~270 ms) with its Plays cell
    counting it; "Unplayed" lists exactly the never-played songs (no playback
    row reads as 0). The preset clicks' config writes are reverted by the
    harness's agent-write ledger. Profile per play: every push load of
    `sonata.songs` scoped (`ids` ≤ 1) — one per subscribed tuple holding the
    song (value role: the Plays cell changes) — and one `windowIdsOf` per tuple
    ordered by a playback column; no loads on other keys.
  - `mailbox-tabs-verify.ts` no longer intercepts the deleted query endpoint: it
    reads each tab's rendered rows (`ThreadRow` now carries `data-thread-id`) and
    seeds a synthetic mailbox on a worktree. Its Filter-pill expectations were
    stale before this change (the trigger's name has been `Filter: <first rule>`
    since the control summaries landed, not `1 rule`; the summary names a tags
    operand by its stored id, `INBOX`, while the popover shows "Inbox"). 27/28
    pass; the one failure is the bare-`/mail` landing, which redirects only once
    the Gmail integration reports access — this worktree's Gmail token is
    unavailable — so that step is now recorded rather than thrown on.
- **Behaviour changes of the live source, stated** (the design asked for
  them): nulls sort last in both directions (the keyset rule — `composer`,
  `playback.lastPlayedAt`, `midi.trackCount` on the library); an enum sort or
  group reads in stored-value order; a user-defined custom column displays but
  is neither sortable nor filterable until P3. The design's "Sonata's grouped
  view loads fully, so it is exact by exhaustion" holds only up to one window
  (100 songs): past that, the last loaded section reads `n+` until a later
  section starts or the scroll reads to the end.
- **Post-review fixes.**
  - A failed read is its error, never an endless loading state: the mail pane
    renders `mailAccount` through `matchResource` (its default error arm), and
    the player title (`SongTitle`) has an error arm on `useLiveRow`'s pending.
  - **A scope column is never offered to Filter** (data-view, not mail prose):
    `resolveLiveFields` leaves a field over a column the source's `scoped({
    where })` constrains out of `filterFields` (it still sorts; a domain
    mismatch still throws). `MailThreadColumn` also excludes `accountId`.
  - **No blink on a song change.** `NowPlayingBar` no longer returns `null`
    while the new point read loads: the bar stays and only its title waits (a
    shimmer, or the read's error) — the not-known-yet state rendered, rather
    than keeping the previous song's title, which would name the wrong song.
  - `GmailAccessEmptyState` (gmail integration web) is the one "Gmail not usable
    yet" surface; mail's landing and the threads pane's no-account state both
    render it (the landing's own `EmptyState` copy is gone).
  - The threads DataView says "No conversations" once a window settles empty.
  - `readMailAccount(executor)` is the ONE account choice (the served value's
    loader and `resolveMailAccountId` both call it), pinned by a DB test
    (`mail-core/server/internal/account.test.ts`: reverse-order inserts, the id
    tie-break, a never-connected account after connected ones, none → `null`).
    The e2e fixture reads the account from the `mailAccount` value over HTTP
    instead of restating the SQL.
  - `authored-views.test.ts` lowers through the real field plan
    (`resolveLiveFields` + `renameColumns`, now on data-view's `web/testing`)
    with fields bound by `mailThreads.column(…)`, and types the collection's
    filterable without a cast.
  - `mailbox-tabs-verify.ts` reads a tab only once its list settled (rows or
    the empty state, the same on two reads; a failed read throws), asserts
    Spam's settled empty state, and on a seeded worktree (tall viewport, nothing
    windowed out) compares each tab's exact row set; on a real mailbox it keeps
    only order-free comparisons. `library-live-sort.ts` refuses main (its play
    is real), refuses a library past one 500-song window, and compares the
    Unplayed count exactly only while it fits on screen.
  - **Not done: `mailAccount` stays un-preloaded.** `preload: "boot-and-keep"`
    would make mail-core eager for every app's boot and add a mail query to
    every boot snapshot, for a value only Mail reads; the cost it removes is one
    dependent round trip when Mail opens, shown as the loading state.

### P3: trigger layout and composite keys

**Changes:**
- `routedTableRequirements`;
- the richer trigger on routed tables (old ∪ new, `keys`, `changed`);
- the changelog columns, `parse-payload`, and catch-up replay;
- the custom-columns augmentor emits a `keyed-side` spec: an `alias(row_key)` route with
  `rows: { data_view_id }` and `match: { column_id }`, whose role is membership only for tuples that sort or
  filter by that `cc-*` field;
- the collection declares `recomputeOn` on its data-view config value, so a column-definition change FULLs the
  tuples and resets the `usesOf` memo;
- A3.

**Proof:** **release history**, then **deploy history**, become windows with custom-column sort and filter. Their
`rev` ticks and `changeTick` refetches are deleted.

**P3 — as landed (2026-09-30; deviations from the text above):**

- **The trigger layout.** `tableLayoutRequirements(routes)` (`resource-runtime/core/routing.ts`, pure) folds
  every bound routed entry's routes into one requirement per table — **carry**: every map `column`, every
  `rows` key and every `Route.match` column; **gate**: the union of every route's `columns` — served as
  server-core's `routedTableRequirements()` and handed to `rebuildTriggers(db, exclusions, requirements)`.
  A routed table's three triggers call a NEW function, `live_state_notify_routed(pk, carry_json, gate_json)`
  (its UPDATE trigger declares `OLD TABLE AS old_rows` too); every other table keeps `live_state_notify()`
  and its DDL byte for byte (`compileTableTriggerDdl` with no layout), and its payload is exactly
  `{t, op, ids, x, at}` — both pinned by `routed-trigger.test.ts`. `resolveLayout` checks the requirement
  against the catalog (a column the table lacks throws at boot) and applies the gate only when it is a
  strict subset of the table's columns on a single-column PK. The first deploy rebuilds the whole layer
  once (the signature covers the new function and the changelog DDL); on this worktree the routed
  function landed on 42 tables. (Since the review fixes below, a later layout change rebuilds only its
  own table.)
- **`Route.match` is declared** (new field): the layout is derived from routes, and a tuple's `match`
  keys come from `usesOf` at runtime, so a route states the columns a match may name. A use matching on an
  undeclared column is reported and FULLs the tuple (like an unknown route id, A9).
- **`keys` ride the wire row-wise** — `{ "c": [columns], "r": [[values]] }`, one array per row, so the
  columns cannot misalign (several `array_agg`s in one query only align by executor accident);
  `parseKeyLayout` turns it into the router's columnar `TableChange.keys` for the listener and the catch-up
  alike. A malformed layout routes unscoped on both paths, reported, never dropped (as fixed after review
  — it first skipped the live NOTIFY).
- **Over the cap, `changed` survives** (deviation): `ids` and `keys` drop as specified, but `changed` —
  a handful of column names, exact whatever the row count — is kept unless the payload is still over the
  cap without them. A bulk UPDATE of a column no route reads (a heartbeat, `pid`) then reaches nothing
  instead of FULLing every reader. Sound: `changed` names the gate columns that moved, and a route's
  columns are a subset of the gate.
- **The gate is live.** `routeTuple` already skipped a `U` whose `changed` missed a route's columns; the
  routed trigger now sends it, so P4's "turn the gate on" is done for every routed table here (route
  columns are exact since P2). P4 keeps the membership-neutral-U-as-value-role idea for identity routes.
- **`changed` compares as text** (`o.col::text IS DISTINCT FROM n.col::text`): json has no equality
  operator; text equality over-reports at worst (never under-reports).
- **Custom columns are a SCOPED column set, the surface static per collection.** The P2 sketch had a
  tuple carry a `surface` param; the P3 text said `rows: { data_view_id: surface }` — a static route. The
  latter landed: `liveCollection(…, { columnScope: "<DataView id>" })` names the one surface a collection
  is listed on (the DataView asserts `columnScope === storageKey` at mount), so no param rides the tuple.
  - `network/live`: `LiveColumns.Scoped(serveScopedColumns({ name, table, scope, hostKey, member, value,
    members, recomputeOn }))` (server) and `scopedLiveColumns(scope, name, members)` (browser; its refs
    carry `scope` instead of a collection key). A `columnScope` collection compiles deferred (like a
    `contributed` one) and folds every `Scoped` contribution. Wire names `custom.<id>`.
  - `query-resource`: a **join family** (`JoinFamily` in core, `familyMember` / `familyMemberAlias` —
    alias `custom__<id with non-alphanumerics as _hex_>`, injective): a tuple joins exactly the members
    its `where` / order names, ONE route per family (`familyRoute`: alias on `row_key`, `rows` = the
    surface, `match: ["column_id"]`), read as membership with a match on the members it reads. A member
    is rendered through `JoinPlan.readMember` (cast + its SQL type, registered like the COALESCE
    expressions; `sqlTypeOf` feeds a cut's operand cast).
  - **Only a sort or filter joins a member** — the plan left "project the referenced or all of the
    surface's columns" to measurement. Not measured; decided on structure: projecting all would add one
    LEFT join per defined column to every statement of every tuple and make every cell edit a value-role
    refill duplicating `customColumnValues`, which keeps serving the DISPLAY. A member the tuple orders
    by is projected under `$scoped` (a declared window-only key like `$key`, split off by every read) so
    the order signature sees it move.
  - **Members are read at request time** (the surface's config), so the decode validates a tuple against
    the definitions as they stand and a retyped column reads its new cast on the next load; a member the
    surface lost fails the load loudly.
  - **`recomputeOn` for a routed entry** (runtime, new): `{ resource, params }` of an EXTERNAL upstream
    tuple, typed on the routed `ScopePolicy` arms only; it FULLs every subscribed tuple and clears the
    `usesOf` memo (an edge filtered to that upstream tuple). A DB-backed or unregistered upstream throws.
    The upstream is `customColumnDefs` (`data-view-custom-column-defs`, external, params `dataViewId`),
    notified from a config watch per scoped surface (`watchScopedDefinitions`, `onReady`) only when the
    definitions changed (a view-state write compares equal). `data-view` gained
    `watchDataViewConfigDoc`.
  - `FieldExtensionProps.liveColumnScope` hands the scope to the custom-columns contributor, which binds
    each filterable / sortable column under it; `Fields.ValueTextCast` gained `sqlType`.
- **`DataViewJoin.apply` → `applyJoin(q, KeyedSideJoin, rowKeyCol)`** (server-query): the augmentor emits
  the family's member join (`familyMember`), so the HTTP and live reads of a column share one alias. The
  remaining HTTP consumers are all-conversations and reports.
- **Release history** is a NEW collection, `release.history` (a `where` on `namespace`, read at bind),
  beside the `release.runs` lookup — a collection's base predicate applies to its `:rows` read too, and a
  run must resolve by id whatever namespace produced it. **The `release.history-revision` tick is kept**:
  remote-deploy's release info refetches the candidate endpoint (a directory walk and git) on it.
  Deleted: `queryReleaseHistory` + its schemas + `SortRuleSchema`, `handle-history-query.ts`,
  `RELEASE_HISTORY_FILTERABLE` / `SEARCHABLE`. **Deploy history**: `deploy.run-history` over
  `deploy_runs`, scoped per deployment by the pane; deleted `queryDeployRuns` + schemas, `handle-runs-query.ts`,
  `DEPLOY_RUN_FILTERABLE` / `SEARCHABLE`, the `deploy.runs-revision` tick (descriptor + server). Both
  files left the legacy-spelling ignore list.
- **Also scoped (beyond the text): the Sonata library** (`sonata.library` — lifting P2's accepted
  regression) **and mail threads** (`mail-threads` — its cc filter had been the error arm).
- **E2E** (both 7/7 against the deploy, `build: success`): `studio/…/release/e2e/history-live-verify.ts`
  and `deploy-history/e2e/history-live-verify.ts` seed three runs, define a number custom column, sort
  by it ascending and filter `> 0`, then write cells through the API: a value → 0 drops the row, → 5 brings
  it back last, another → 9 moves it to the bottom, and a status flip in the DB lands on its row — no
  reload. New helpers: e2e-harness `openDeployDb()` (refuses main), custom-columns `e2e/`
  (`defineCustomColumns`, `setCustomColumnCell`, `clearCustomColumnValues`, `setSurfaceConfig`).
  **Profile** (`get_runtime_profile`, over the three release runs of the session): 7 `release.history`
  push loads, every one scoped (`ids` ≤ 3; a single cell write refilled 1 row), 5 `windowIdsOf` (exits,
  entries, reorders); no FULL push load. The
  `data_view_custom_values` route spans carry no `ids` (composite key) — the refills are scoped by the
  carried `row_key`.
- **Tests**: `change-feed/…/routed-trigger.test.ts` (DB: unrouted DDL and payload byte-identical; I / U / D
  layouts; a moved host key names both hosts; the gate — changed columns, the known empty set, a PK change
  NULL; a composite PK; over-cap; changelog ≡ NOTIFY; A3 fixtures and a missing column failing the
  rebuild), `parse-payload.test.ts` (layout, empty vs null `changed`, malformed), `catch-up.test.ts`
  (replay of `keys` / `changed`, malformed → unscoped), `resource-runtime`: `routing-layout.test.ts`, and
  in `runtime-table-routing.test.ts` a match on an undeclared column, a key-changing identity UPDATE and
  the routed `recomputeOn` (FULL + memo reset, another tuple reaches nothing, the three refusals);
  `network/live`: `serve-collection-scoped.test.ts` (route, usesOf roles and matches, SQL, `$scoped`
  fold + signature, cast at load time, a lost member, `recomputeOn`, provenance per shape, refusals) and
  `serve-collection-scoped-oracle.test.ts` (DB oracle through the real routed triggers: 50 random host /
  cell / other-surface / bulk steps, every view converges, no FULL, refills within the changed hosts, a
  tuple not reading a column loads nothing for it, then a definitions change FULLs every tuple once);
  `data-view/…/live-fields.test.ts` (scoped refs, the mount assert).
- **Left for later**: the mail threads fixture could use `openDeployDb`; the `captureWatermark … hooks
  installed` log noise in DB suites (pre-existing, seen since P2) is still uninvestigated.

**P3 review fixes — as landed (2026-09-30).** A review of P3 found three medium and eight low
problems. Each was checked against the code; the valid ones were fixed, and none was dismissed:

- **A retyped member a tuple sorts by kept its old cast** (`compile-window.ts`): the per-tuple order plan
  was memoized by relation, column name, direction and nullable. A retyped member keeps its alias and
  column, so the ORDER BY, the `$scoped` projection (`__family_<i>`) and a cut's operand cast kept the old
  cast until a restart (only the filter re-read it). The memo key now carries each key's rendering: an
  expression key by its (registered, cached) object and SQL type. Test: a retype under a sort re-renders
  the ORDER BY, the projection and the row-key part (`serve-collection-scoped.test.ts`).
- **One table's changed layout rebuilt every table** (`triggers.ts`). `live_state_trigger_state` is now
  ONE ROW PER OBJECT: each triggered table's compiled-statement hash, stamped in the same transaction that
  installs its triggers, and the shared layer's (functions + changelog DDL, under the empty name), stamped
  in the prelude. `planRebuild` rebuilds only the tables whose signature moved or whose triggers are gone,
  runs the prelude only when the shared layer changed, drops stale triggers and forgets rows of tables that
  no longer exist. A signature is therefore always what is installed, whatever boot dies where (the old
  last-stamped whole-layer row could, after a rolled-back deploy, match a layer that was half the other
  version). A state table in the first one-row shape is dropped and recreated — one rebuild of every
  table, once (seen on this worktree's deploy: 112 of 112, then "up to date" on the next boot). Tests
  (`triggers.test.ts`): a new table rebuilds no other (trigger oids unchanged), a layout change rebuilds
  that table alone and back, a dropped table's row is forgotten, the one-row table is replaced.
- **The changelog's `ADD COLUMN IF NOT EXISTS` could stall every write** (`triggers.ts`):
  `ensureChangelogTable` now reads the catalog first and issues the CREATE TABLE, each ALTER and the
  CREATE INDEX only for a piece that is missing (the `CREATE INDEX IF NOT EXISTS` took a SHARE lock on the
  changelog on every rebuild too, before P3). Test: with a transaction holding a changelog write open,
  `ensureChangelogTable` returns at once; an older changelog gains the two columns.
- **A3 did not check the PK or the gate** (`route-layout.ts`): A3 now also requires argument 0 to be the
  table's single-column PK ('' for a composite one, read from `pg_index` beside the trigger arguments) and
  argument 2 to be empty or hold every column the routes read. Violations are a typed union (`unrouted`,
  `pk`, `carry`, `gate`). Tests in `routed-trigger.test.ts`.
- **Live and catch-up disagreed on a malformed layout**: `readLayout` (`parse-payload.ts`) is now the one
  rule both apply — a `k` / `c` that does not parse makes the change unscoped (`ids`, `keys`, `changed`
  null) and is reported through a callback (`parseLiveStatePayload(raw, onMalformedLayout)`); the listener
  and the catch-up both log it. `parseKeyLayout` left the barrel (its only outside reader was the
  catch-up). Tests: `parse-payload.test.ts`, and a routed-payload case in `listener.test.ts` (a layout
  delivered; a malformed one routed unscoped).
- **Catch-up replayed `changed` computed under the old gate**: the replay now sends `changed: null`. A
  catch-up always follows a restart that may have changed the routes, and a known `changed` missing a
  column a new route reads would skip it. `keys` replay as written (a column the old layout lacked reads
  as unknown, which recomputes). `catch-up.test.ts` updated — a behaviour change from the landed text.
- **The watch set was a side effect of `recomputeOn`**: `ServedScopedColumns` gained `bind(scope)` (the
  collection's fold, which records the scope and returns its family) and `scopes()`;
  `watchScopedDefinitions` iterates `customScopedColumns.scopes()`, and the owner's `recomputeOn` is pure.
  The HTTP augmentor keeps calling `family(scope)`, which records nothing. Test: the fold records the scope.
- **The routed `recomputeOn` edge scanned sockets**: it now takes `routedTargets(down)` — the `tracked`
  index (plus `{}` for a persisted entry), the same targets a table change considers.
- **Doc drift**: the `familyMemberAlias` example, the KeyedSideJoin "until P3" note, the runs tick's
  "mirrors `deploy.runs-revision`", and the runs / reports endpoints' deleted precedents.
- **Member alias length**: a spelling past 63 bytes becomes `<family>___h<FNV-1a 128, base 36>` — a form no
  spelled alias can take (a spelled member starts with `[A-Za-z0-9]` or `_<hex>`) — and two members meeting
  on one alias now fail the compile instead of sharing the first one's join. Test: the real `cc-<uuid>` id
  still spells out (62 bytes); a longer one hashes within the limit.
- **Verification**: after `./equin build` (success), `deploy-history/e2e/history-live-verify.ts`
  7/7. `get_runtime_profile` over that run: `deploy.run-history` 1 sub load, 5 push loads all scoped
  (`ids` 1, 1, 1, 1, 3), 4 `windowIdsOf`, no FULL load. The mail threads, mailbox tabs, Sonata library and
  release history e2e scripts were re-run on that deploy, after both collections gained a `columnScope`:
  threads-live 7/7, Sonata library-live-sort 7/7, release history-live 7/7, mailbox-tabs 27/28 — the one
  failure is the bare `/mail` → `/mail/threads` redirect, which needs a Gmail token this worktree does
  not have (failing identically since P2).

### P4: N:1 lookups and the gate

**Changes:**
- `reverse` routes, drain-time batched resolution, the cap and `within`;
- the changed-columns gate;
- A10.

**Proof:** the **events list** is `from: events`, with `lookup("source", _eventSources, required)`, the base
`enabled` predicate, and a `reverse(source_id)` route gated on `{id, type, config, enabled}`:
- a status or watermark flip routes nowhere;
- an `enabled` flip refills at most 500 hosts, then goes FULL (bounded window);
- a source D arrives as event Ds through identity.

`events.revision` is deleted.

**P4 — as landed (2026-09-30; deviations from the text above):**

- **Reverse routes are compiled** (`query-resource/server/internal/joins.ts`,
  `reverseMap`). A lookup not keyed by the host identity routes `reverse` on its
  `pk`; its `resolve` probes `SELECT DISTINCT <host pk> FROM <base> [the joins up
  to on's relation] WHERE <on> = ANY($1::<type>[]) [AND <pk> = ANY($2::<type>[])]
  LIMIT cap + 1` — one array param per list, cast to the column's type — through
  the spec's `db`, and answers `"over-cap"` past the cap. The runtime half (drain
  batching, `within`, cap 500, over-cap / throw ⇒ FULL, the same-pending ack) was
  already P0's; it now has a production caller. Replaces P2's placeholder
  `full: "reverse routes land in P4"`.
- **A10 is narrower than "any hop through the changed table".** A self-join on
  the base (a node's parent: identity + reverse on one table) probes the HOST
  rows' referencing column, which is complete after commit — a host that moved its
  own key is its own identity change. Only a chain whose intermediate hop is a join
  over the changed table itself compiles to `full`, reason `pre-image needed: …`
  (no layout carries such a hop's pre-image; the resolve never reads carried keys).
- **`TupleUse.moves`** (new; the "membership-neutral U as value-role" follow-on
  recorded in the adapter design, built here): a membership use carries the
  columns of its table whose change can move THAT tuple — its where / order
  columns and the conditions of the joins it reads as membership, compiler-derived
  in `routedReads`. A `U` whose known `changed` misses them is routed in the value
  role (`routeTuple`): an identity U to a non-member loads nothing and a member's
  refill runs no `windowIdsOf`; a lookup's projected-only column (`type`,
  `config`) resolves within the members. `I`, `D` and unknown `changed` stay
  membership. So a host-table change reaches only the segment holding the row
  (the Known limit below is closed for membership-neutral updates).
- **The gate rule was wrong for a table the union covers whole.** P3 computed
  `changed` only when the union of route columns was a strict subset of the
  table's; `event_sources` is listed whole by the sources collection, so the
  lookup's narrow route could never skip a `status` flip. `TableLayoutRequirement`
  gained `narrowest` (the fewest columns any one route reads) and `resolveLayout`
  gates when `narrowest < table columns`. On this worktree `event_sources` now
  carries `id` and gates on every column; tables whose every route reads all of
  them stay ungated. (**Superseded by the review fixes below:** this gated 13
  more tables on EVERY column — `mail_messages` 24/24, `claude_cli_calls`,
  `mail_threads`, `conversation_summaries`, `event_emissions`, `dead_jobs`,
  `deploy_deployments`, `trash_entries`, `pushes`, `sonata_songs`,
  `browser_bookmarks`, `plugin_health_reviews`, `event_sources` — and rebuilt
  their triggers once; `changed` became `unchanged`, compared over the narrow
  routes' columns only.)
- **Default scopes** (new, `serveCollection`'s `defaults: [{ unless, where }]`):
  the events list's "unless the tuple filters by sourceId" is a per-tuple base,
  which `where` could not express. A default is ANDed into a window or grouping
  tuple whose filter does not name `unless` (any op), never into `:rows`; its
  columns join the route columns (`whereReads` / `reads`), and a join it reads is
  membership for the tuples it applies to. `disappearedAt IS NULL` is the second
  default (the fetchPage handler had both as `scope.ts` rules).
- **The events list** (`event-list`): `eventsList` (`events.list`, `scroll`, H 100 /
  M 500, `startsAt asc`, `columnScope: "events.list"`) served from `events` with
  the required `source` lookup; the row is `SourcedEvent`, now FLAT
  (`sourceType` / `sourceConfig` — a projection is columns; `sourceRefOf` reads
  the ref back; the run pane's `listRunEvents` projects the same) over
  `ListedEvent`, the event without its sighting stamps, so a re-extraction that
  re-sees an unchanged event moves no row (they were never rendered).
  Deleted: `queryEvents` + schemas + `SortRuleSchema`, `handle-query.ts`,
  `column-map.ts`, `scope.ts` (+ test), the `events.revision` tick (descriptor,
  server resource, `useEventsRevision`). `events.runs-revision` stays (the run
  ledger). **Behaviour change:** tags are no longer search text — the fetchPage
  query searched `tags::text`, and a live collection's filterable columns are row
  fields (a filter-only expression column would be new live API); the Tags
  filter still finds one. The two e2e scripts that read `POST /api/events/query`
  (`open-event-verify`, sources' `source-actions-verify`) now read the
  collection's HTTP resource read (`GET /api/resources/events.list[:groups]`),
  counting through the grouping (per-source counts, the default dropped by
  naming the source). `open-event-verify` now reads the landing view's own
  question (Upcoming: from today, soonest first — the collection default reads
  past events too) and was re-run: every functional step passes (a link-less
  event opens its source's page); its "no console errors" step failed on a 429
  from `/api/logs/emit`, the log channel shedding while the host duress latch
  was set (load average 25–35 during the run) — not this change.
  `source-actions-verify` was not re-run: its last step enqueues real refresh
  runs (model calls for `url` sources).
- **Groups route a keyed side by its selectors**: `compileGroupsQuery`'s `full`
  route for a keyed-side join now carries `rows`, so a write to another scope's
  or member's rows moves no count (found by the oracle).
- **Mail threads' account (re-checked):** not a lookup workaround. P2 made the
  account a SCOPE (`mailAccount` value + `scoped({ where: { accountId } })`),
  because a required lookup cannot say "the one account" — it matches every
  thread. The collection has no joins and no `full` route; nothing moved.
- **Tests:** `resource-runtime`: `runtime-table-routing.test.ts` "moves" (identity
  U to a member / non-member, a moving column, I / D / unknown stay membership, a
  reverse U within members vs unbounded), `routing-layout.test.ts` (`narrowest`);
  `change-feed`: `routed-trigger.test.ts` (`resolveLayout`: a whole-table union
  with one narrow route gates, all-wide or composite does not);
  `network/live`: `serve-collection-joins.test.ts` (reverse routes and their probe
  SQL, a chained probe with `within`, over-cap and an empty `within`, A10's
  pre-image `full`, a base self-join, `moves` per tuple, default scopes: applied /
  dropped / never on `:rows` / on groups / an `unless` naming no filterable
  column throws); `compile-window.test.ts` (`moves` in a use);
  **`serve-collection-lookup-oracle.test.ts`** (Verification §3's lookup,
  keyed-side and self-join fixtures, DB, real routed triggers: 70 random host /
  source / note steps — inserts, moves of `src_id` / `parent_id`, deletes,
  cascades, multi-row updates, relabels, `enabled` flips — every view converges,
  no window / point FULL, refills within the host / the source's hosts / the
  children; a source `status` flip, another member's or surface's note load
  NOTHING; reverse refills happened; then 501 hosts: an `enabled` flip over the
  cap FULLs the reading window, one under it refills only the source's items).
- **E2E** (`event-list/e2e/list-live-verify.ts`, 9/9 against the deploy, `build:
  success`): seeds a source and three events, then writes the DB directly: a
  `status` / watermark write sends NO `events.list` frame; `enabled` off drops the
  rows, on brings them back; a `config` edit lands on the rows (an `events.list`
  frame carrying it); deleting the source removes them; no reload.
  **Profile** (`get_runtime_profile` over that run): `events.list` — 1 sub load, 3
  push loads all scoped (`ids` 3: disable, enable, config), 3 `windowIdsOf` (exits,
  entries, the delete's exits), 4 reverse resolves (`cascade`, ≤ 1.6 ms: disable,
  enable, config, delete — the delete's finds nothing, its events arrive as
  identity Ds), no FULL, and nothing for the two status / watermark writes.

**P4 review fixes — as landed (2026-09-30).** A review of P4 found two medium
and five low problems. Each was checked against the code:

- **The whole-table gate cost (medium, fixed; finding 7's doc omission with
  it).** `narrowest` gated a table whenever one route was narrow, but compared
  the union of EVERY route's columns — so a `mail_messages` `unread` flip
  compared (and detoasted) `body_html`, `body_text` and the jsonb headers per
  row, to skip nothing: a route reading every column is hit by any real change.
  Comparing only the narrow routes' columns needs the router to know which
  routes the comparison covers, and a gate list the reader must agree with is a
  coupling (the P3 review already found it once: catch-up had to null a
  `changed` computed under an old gate). So the fact changed instead, rung 1:
  **`TableChange.changed` → `unchanged`**, the columns KNOWN equal in every row
  (old and new paired on the PK). A route skips a `U` whose `unchanged` lists
  all its `columns`; a use whose `moves` are all listed reads it as value. A
  column the producer did not compare is simply not listed, so the fact is
  sound whatever the gate — no agreement to keep:
  - `TableLayoutRequirement` carries `reads` (each route's column set,
    distinct) instead of `gate` + `narrowest`; `resolveLayout` gates on the
    union of the sets narrower than the table. Deployed on this worktree:
    `mail_messages` compares `thread_id` only, `claude_cli_calls` `model,
    source_name`, `pushes` `attempt_id`, `event_sources` `config, enabled, id,
    status, type` (a grouping reads `status`), `dead_jobs` / `event_emissions`
    nothing (their narrow routes read no column: a `U` there now reaches those
    routes, as in P3 — the pairing is not run without a column to compare).
  - The trigger emits `u` (was `c`), the changelog column is `unchanged`
    (added by `ensureChangelogTable`; this worktree's database keeps an unused
    `changed` column from P3's deploy — main never had it).
  - **The catch-up replays `unchanged` as written** (the P3 review fix's
    `changed: null` is reverted): it is a fact about the rows, not about the
    gate, so a replay after a deploy that changed the routes stays sound.
  - **A3 no longer checks the gate** (the `gate` violation kind is gone): any
    installed gate is sound; a narrower one only skips less.
  - Tests: `routing-layout.test.ts` (`reads`, one set per distinct route),
    `runtime-table-routing.test.ts` (the gate and `moves` over `unchanged`; a
    column the producer did not compare is reached), `routed-trigger.test.ts`
    (a whole-table route beside a narrow one: only the narrow columns compared,
    `secret` never listed; over-cap keeps `unchanged`; `resolveLayout`'s union
    of narrow sets), `parse-payload.test.ts`, `listener.test.ts`,
    `catch-up.test.ts` (replayed as written), `triggers.test.ts`.
- **Tags no longer search (medium, NOT fixed — needs a user decision).** The
  events search box stopped matching tags (see the events list bullet above).
  Restoring it is filter-language work, not live API: a `stringArray`
  "an element contains" op the search could lower to (`lowerSearch` accepts
  text columns only today), with its SQL template, its JS evaluation and its
  parity test — and it would appear as an operator wherever that domain's ops
  are offered. Left as landed until the user chooses.
- **Spurious over-cap FULLs (low).** (b) **fixed**: `resolveReverseRoutes`
  resolved every reader unbounded once any reader was membership, so an
  `enabled` flip over the cap also FULLed a value reader bounded to its
  members. Bounded and unbounded readers now resolve as two groups: the
  unbounded probe serves everyone when it fits the cap (each bounded reader
  cuts it to its own ids — still one query); over the cap only the membership
  readers go FULL and the bounded ones probe again within their members.
  Tests: a membership + value reader share one unbounded resolve; over the cap
  only the membership reader loads FULL. (a) **not fixed**: ANDing the
  collection's static `where` into the probe helps no collection today (none
  has a base `where` beside a lookup — the events list's predicates are
  per-tuple DEFAULTS, and its `enabled` one reads the looked-up row, whose
  post-image must not filter: a disabled source's events are the ones to
  exit). Recorded under Known limits.
- **Workload gaps (low, fixed).** `serve-collection-lookup-oracle.test.ts` now
  also rekeys a host (`UPDATE … SET id`: old and new ids, the children naming
  either re-read their parent) and a source (its FK `ON UPDATE CASCADE` moves
  its items), and runs two statements over the NOTIFY cap over 40 long-id
  fillers: an `n` bump (ids and keys verified dropped; the bounded FULL is
  allowed for that step only) and a `touched` bump of a column no route reads
  (`unchanged` survives, nothing loads). The workload asserts both rekeys and
  an over-cap step ran. `runtime-table-routing.test.ts` gained the quiescence
  guard for `moves`: a membership-neutral U to a non-member in the same flush
  as a pending for the tuple, and one committing while a drain admits that very
  host — both delivered as membership, the client converging.
- **Encoded identity beside a reverse route (low, fixed as a compile-time
  refusal).** `compiledRoutePlan` (query-resource `routes.ts`) throws on a
  `reverse` route beside an `identity` route with `encode`: the probe answers
  and reads `within` as raw pk values. P6's union compiler must encode the
  answer and decode `within` before it can emit both. Test: `routes.test.ts`.
- **Doc drift (low, fixed).** `events-core/CLAUDE.md` names the
  `events.list` collection and the flat `sourceType` / `sourceConfig`.

Verification: `./equin test` over `resource-runtime`, `query-resource`,
`change-feed`, `live-state-snapshot` and `network/live` — 777 bun tests over 62
files and 39 vitest tests pass; `./equin check type-check` ok;
`./equin build` success (the rebuilt triggers' gates read back from
`pg_trigger` as listed above).

**Final holistic review fixes — as landed (2026-09-30).** Three reviews of the
whole P0–P4 change (runtime correctness, architecture, UI/UX + perf) found three
major and fifteen minor problems. Each was checked against the code; every one
was valid and fixed:

- **A sub-ack joining a read begun before a push regressed the snapshot
  (major, runtime).** The P0 re-seed guard compared the version the SUBSCRIBER
  observed, but a subscriber that joins a parked read after a push observes the
  pushed version while its value is the older read's — so it re-seeded the
  snapshot without the host the push admitted, and that host's later side
  write was dropped as a non-member's. The flight now co-produces a fourth
  stamp, `baseVersion` (the tuple's version when the read STARTED, read in the
  starter's factory), and `serveSub` re-seeds only while the version still
  equals it. Test: `runtime-snapshot-base.test.ts` (three sockets, one joining
  the parked read).
- **A drain that outlived the last unsubscribe resurrected a snapshot (major,
  runtime).** Both membership drains (and the legacy keyed branch) wrote their
  snapshot after their awaits, even when the tuple's last subscriber had left
  meanwhile; nothing routes to an untracked tuple, so the resurrected base went
  stale unseen, and a re-subscribe's routing read membership off it. A tuple's
  snapshot now belongs to its TRACKING SPAN (`entry.spans`: a fresh number at
  the global 0→1, deleted at N→0); a drain reads `snapshotOwner` before its
  first await and writes the snapshot, order signatures and frames only while
  it is unchanged (a persisted alias's kept snapshot is `"kept"`, always its
  own). An untracked tuple (a value-aware downstream alone) no longer seeds a
  snapshot nothing would keep current. Test: `runtime-snapshot-base.test.ts`
  (unsubscribe during a parked drain, re-subscribe with a side write landing
  during its first load).
- **The substrate spellings bypassed `no-legacy-resource-spelling` (major,
  architecture).** `defineDeferredResource`, `deferredWindowQueryResource` and
  `useResources` are in the rule's tables now (replacements: `serveCollection`,
  `useLive` / a DataView `liveDataSource`); the substrate globs already exempt
  their callers. Test: the rule's `RuleTester` case.
- **A table header could persist a sort the live source refuses (major, UI).**
  A header was sortable whenever its field had a `value`; under a live source a
  derived or unsortable column's click wrote a rule that replaced the list with
  `UnavailableSortRuleError`, persisted in config. `DataViewRenderProps` gained
  `sortHeader: { active, sortable }` — the Sort control's sortable field ids,
  and the ACTIVE sort for the arrow (which also restores the arrow on
  server-ordered lists, whose `state.sort` is emptied — the Sonata minor) —
  `DataTable`'s `ColumnDef` an explicit `sortable` (default: has a `value`, so
  its other consumers are unchanged), and the host's `setSort` throws for a
  field outside the set. Test: `table/web/__tests__/header-sort.test.tsx`.
- **Minors, fixed:**
  - `useResources` reports each tuple's mount→settle to `slowResourceReportSink`
    through the same `reportTupleSettled` as `useResource` (segmented reads
    reach Debug → Slow Ops again); test in `use-resources.test.tsx`.
  - `LiveColumnRef` is branded (`core/internal/column-ref.ts`, `mintColumnRef`,
    module-private symbol): a hand-written literal is a tsc error.
  - `RoutedRecomputeOn<P>` is `{ resource: ExternalResource<any, P>; params:
    NoInfer<P> }`: a DB-backed upstream is a tsc error (pinned by a
    `@ts-expect-error` beside the runtime throw), and `serveScopedColumns<P>`
    checks the params against the upstream.
  - `defaults[].unless` is typed to the collection's own filterable names
    (`ServeCollectionOptions`' new `U` parameter; `never` on a lookup-only
    collection); the module-eval throw stays for a cast.
  - `TableChange.unchanged` is required (`null` = unknown, one spelling).
  - Stale docs: query-resource's non-PK identity route (scoped since P3),
    change-feed's `event_sources` gate (`config, enabled, id, status, type`),
    release's index comments (the `release.history` window), Sonata's `Fields`
    slot prose (hook-free contributors reading `$columns`).
  - `withoutRowKey` → `withoutWindowFields` (`web/internal/window-fields.ts`).
  - `ServedScopedColumns.family` → `unwatchedFamily`: the name says the scope
    it returns is not watched for definition changes; a fold calls `bind`.
  - Sonata's "File" (`sourceMissing`) is sortable again (the scroll-key
    round-trip test now covers a `boolean` order column).
  - The truncated footer speaks the user's language: the plan's truncation is a
    KIND (`ScrollTruncation`: `"segment-cap"` | `"long-sort-key"`), worded per
    kind by the DataView (`TRUNCATION_HINT`) and logged once in the plan's terms
    (`TRUNCATION_DETAIL`, `live-scroll` channel).
  - Mail threads and release history show ONE loading state: a live source may
    await its scope (`source.awaitingScope([columns])` — reads nothing, keeps
    those columns out of Filter already), so the DataView mounts with its
    toolbar while `mailAccount` / the compositions config load.

### Follow-up task (one task, filed after approval): P5–P8

| Phase | Content |
|---|---|
| **P5 reports producer** | `defineChangeProducer` (volatile, after commit); `recordReport` / `investigateReport` / `backfillNoise` emit their ids; the retention sweep emits a D from `DELETE … RETURNING id`; A2 and A6. The reports window keeps `debounceMs: 2000`. `reports.revision` is deleted. |
| **P6 runs union** | A union window compiler (sibling of `compile-union.ts`) with one `identity(encode: v => kind:v)` route per arm (`runs/core/internal/wire.ts:49-51`). `base.id` becomes a `PgColumn` (type). `usesOf` drops pruned arms. `runs.revision` is deleted. `duration` / `now()` is a separate item-7 concern. |
| **P7 conversations** | Compiled from `_conversations` with `lookup(attempt, _attempts, required)` → `lookup(task, _tasks, required)` plus custom values, never from `conversations_v`. A task rename reaches exactly its conversations. This closes item 7's routing needs. |
| **P8 retire edges** | Move `attempts`, `tasks` and `agent-launches` onto routed compilers where expressible, which fixes C1 and deletes the `pushesAttemptsCascade` carrier. Delete `rel` / `compileEdge(s)`, `coveredOriginsFor`, the edge-covered `continue`, the uncovered `affected = null` branch, the secondary-view dedup and the view forwarding once the last legacy reader is gone. `tasks_v` / `task_blocking_v` stay `full` with a reason until a closure route is justified by measurement. Structured `View({plan})` is deferred. |

## Known limits (accepted, and listed by A7)

- (P5) A change producer is volatile: a pending coalesced change is lost on a restart or hot swap (clients
  resubscribe and reload in full); within one subscription a lost emit heals membership but not the values of
  rows already in the base. A6 refuses any L2-persisted reader of a produced table.
- (P5) A grouping over a produced table recomputes whole on every flush that touches the table (a producer
  change has no `unchanged` set to skip it by).

- A relevant write costs a `:groups` tuple one bounded aggregate, not O(changed).
- A membership-role lookup flip over the cap is one bounded window FULL per reading tuple.
- A reverse probe applies none of the collection's predicates: hosts no tuple can hold (a
  disappeared event) count toward the 500 cap. A per-tuple default cannot be ANDed into a probe
  shared by every reader, and a predicate on the looked-up row must not filter its post-image;
  a host-only static `where` could be, once a collection has one beside a lookup.
- A potential entrant still costs one bounded `windowIdsOf`, the same as a host-column write today.
- Opaque `serveValue`s (`customColumnValues`, `taskDetail`) and hand-written tree resources stay legacy FULL until
  they are compiled.
- (Closed in P3: a key-changing UPDATE on a routed table now names its old and new ids / keys.)
- A custom column retyped or deleted under a live tuple: the tuple recomputes FULL on the definitions change;
  a filter over a deleted column then fails that tuple's load loudly until its client re-lowers without it.
- A live DataView scroll holds at most `MAX_SCROLL_SEGMENTS` (16) segments of ≤ `maxLimit` rows each, and its
  rendered rows are always a gap-free prefix of the order: at the cap a segment that must split collapses the
  segments after it (they reload on scroll), and only a tail that cannot split says it is truncated. A
  host-table change moving a tuple's where / order columns costs one scoped refill per loaded segment; a
  membership-neutral one reaches only the segment holding the row (P4's `moves`).

## Critical files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts`: `mergePending` 2058-2114, cascade 2888-3008,
  `drainMembershipScoped` 3198-3529, `drainEntry` 3537-3912, `releaseSubRefcount` 4560-4599, `applyDbChange`
  4953-5109; new `core/routing.ts`; `core/test-support.ts`
- `plugins/framework/plugins/server-core/core/resources.ts` (capture binding),
  `plugins/infra/plugins/runtime-profiler/core/recorder.ts`
- `plugins/infra/plugins/query-resource/server/internal/{compile-window,spec,identity}.ts`; new `core/` join types
- `plugins/network/plugins/live/server/internal/serve-collection.ts`
- `plugins/database/plugins/change-feed/server/internal/{triggers,parse-payload,route-change,identity-coverage}.ts`,
  `server/index.ts`
- `plugins/database/plugins/live-state-snapshot/server/internal/{catch-up,tables-ddl}.ts`
- `plugins/infra/plugins/entity-extensions/server/internal/define-extension.ts`
- `plugins/primitives/plugins/data-view/plugins/{server-query/server/internal/augment.ts,custom-columns/server/internal/query-augmentor.ts}`
- Proof sites:
  - mail threads (`mail/plugins/threads`);
  - Sonata library (`sonata/plugins/library`, `playback-history`, `sources/plugins/midi`);
  - release history (`release/server/internal/handle-history-query.ts`);
  - deploy history (`deploy/plugins/deployments`);
  - events (`events/plugins/event-list`, `events-core`).

## Verification

1. **Harness matrix** (DB-free, new `runtime-table-routing.test.ts`, routes injected through `test-support.ts`).
   - Axes: op (I/U/D, `keys` null) × map kind (identity, identity + encode, alias, reverse, full) × role × membership
     kind (window, point, alias) × several routes on one table.
   - Each cell asserts: which tuples get a pending, scoped vs FULL vs ack-only, `deleted` only from identity, the
     loader ids, the frames, `ackTx` only after every route has landed, `lastNotifyAt` refreshed, skipped tuples'
     versions unchanged, and fail-open on a throwing `usesOf` / `encode` / `resolve`.
2. **Named scenarios:**
   - a cascaded ext D plus a host D, in the same flush and in split flushes;
   - a key-changing UPDATE;
   - an `enabled` flip under and over the cap;
   - a write to custom column c2 while a tuple sorts by c1 (no load);
   - reverse and identity on the same xid (one ack);
   - a persisted skip (no load);
   - the quiescence race (a side write committing during an admitting drain ends fresh);
   - a param'd routed entry with no subscribers gets no `{}`;
   - A5 throws.
3. **Differential oracle** (DB, `db-test-fixture`).
   - Fixture tables: an extension, a lookup, a keyed-side table and a self-join, all going through the real
     triggers.
   - Workload: random I/U/D (bulk over-cap writes, FK moves, key changes, cascades) interleaved with
     subscribe/unsubscribe.
   - At quiescence, every `makeClientView` equals a fresh FULL load of its tuple. Tuples whose `usesOf` lacks a
     table log zero loads, and refill row counts are at most the changed hosts. This proves outcomes 1–3.
4. **Provenance property test.** For random decoded window params, the relations in the rendered SQL of every
   shape equal the tables of `usesOf(params)`. This proves outcome 4.
5. **Feed DB tests** (`listener.test.ts`, `catch-up.test.ts`): the layout / `changed` payloads, over-cap nulling
   all three, changelog replay parity, composite PK, key change.
6. **Assertion fixtures** for A1–A4 and A10, in the style of `identity-coverage.test.ts`.
7. **Per proof site** (`./equin build`, then an e2e script in the owning plugin, e.g.
   `sonata/plugins/library/e2e/library-live-sort.ts`): edit the side value in a second tab and see the row move.
   `get_runtime_profile` should show one scoped refill plus at most one `windowIdsOf`, and no loads on unrelated
   keys or tuples.
8. `./equin check` and `./equin test` over `resource-runtime`, `query-resource`, `network/live`,
   `change-feed`, `live-state-snapshot` and the proof-site plugins.

## Design provenance

This design came from a five-reader code map, a completeness critic, and a three-lens design panel (a query plan
held as data; the smallest runtime surface; a correctness adversary). Two judges tried to refute each design, and
a synthesis step merged them.
- Winner: the query-plan-as-data design, stripped of its new plugin, its view rewrites and its in-transaction
  reports emit.
- Grafted from the other designs: the `pendingAcks` split, the FK-direction rule, the parallel legacy path, the
  one-change-source rule (A2), several routes per table, the compiler-derived changed-columns gate, and the
  quiescence guard.
