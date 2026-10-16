# Resources track: declared reads for database-backed live values (v2)

Track: Network Layer › Resources (page `block-f64cfc08-6ec6-4ef3-9122-f143cc24798e`). Covers the item "Routing for DB values" and [9] "delete the legacy read-set router".
v1 (superseded): `2026-10-15-global-live-declared-reads-for-db-values.md`. Background: `2026-10-13-global-live-latency-in-slow-ops.md` Part 1.

## Context

Live data reaches a tab in one of two ways today:

- **Collections are routed by construction.** Their SQL is compiled from their declaration, so the compiler also knows which rows each subscription reads. A write to page X's row reloads only page X's subscription.
- **Database-backed values are routed by observation** (the legacy router, `applyLegacyFullChange`, `resource-runtime/core/runtime.ts:7146`).
  - Their loader is hand-written SQL, so the runtime records which tables the loader touched (the "read-set").
  - From then on, any write to any of those tables fully reloads every subscribed tuple.
  - External values whose loaders also query Postgres are reached the same way, through their `legacyReach`.

**Inventory**, from the live `/api/resources/_debug` on main (2026-10-15) and a static scan:

- **30 values have policy `legacy-full`.**
- **11 external values read the database** (their `legacyReach` is non-empty, or they are `no-db-backed-notify` debt):
  - `edited-files`, `allow-files`, `review.plugin-changes`
  - `jsonl-events`, `background-shell-output`, `subagent-activity`, `subagent-transcript`
  - `automations.catalog`
  - `background.catalog`, `background.recent-runs`, `queue-health.pulse`
- The per-value classification is in this session's scratchpad research. It will be folded into the session-1 notes.

**Why not hand-written per-row `match`** (the v1 draft):
- A loader's SQL and a separately written `match` are two statements of one filter, and nothing checks that they agree. The A8 drift guard compares tables, not rows.
- A wrong match is a permanent silent miss. The skipped tuple even acks the write, so an optimistic edit reverts in the UI.
- That is worse than today's router, which over-reloads but never misses.

## Target model (the clean long-term state)

1. **A row filter the router relies on is the same expression that filters the SQL.** Only a compiler can guarantee that. So per-row narrowing exists only for compiled queries, as for collections today. **A hand-written `match` has no spelling.**
2. **Hand-written loaders declare whole-table reads, with a reason.**
   - A whole read cannot miss a row, so it is correct by construction.
   - It may name a view or a rollup. The runtime expands it to its base tables, the way the legacy router does.
3. **Values whose payload is rows are collections** (D1 of the live-values design: "a keyed payload is a collection"). Examples: `page-blocks`, `data-view-row-order`, `active-data.bindings`.
4. **Values computed from a few rows read those rows from collections**, and are reloaded when those rows change. Examples: `attempt-work`, `commits-graph.graph`, the worktree-path and transcript lookups of the externals.
5. **Totals, top-N lists, search and singletons stay whole-table.** Examples: `notifications.unread`, `browser-recents`, `search.results`, the chord singletons. For them whole-table is the honest answer, not a gap.

**Restated exit criterion** (replaces "every database-backed read is routed; nothing legacy-full except declared external sources"):

> Every DB-backed read is declared and routed through one router. A collection's plan is compiled from its query. A value declares whole-table reads with a reason, and narrows to rows only through compiled queries. `applyLegacyFullChange` is deleted, and no `_debug` entry has a non-empty `legacyReach`.

Points 3 and 4 are the **performance** half. They become the next track item, with measured before/after numbers. This round is the **correctness and cleanup** half: declared reads, one router, the legacy router deleted. **This round has no performance change**, since a declared whole read reaches exactly what the read-set reached.

## This round's design

### Spelling

```ts
serveValue(notificationsUnread, {
  source: "db",
  reads: { tables: [notifications], reason: "the bell badge counts the whole table" },
  loader: countUnread,
});

serveValue(automationsCatalog, {
  source: "external",
  changes: "notified",
  reads: { tables: [tasksView, tasksOrigin.table, …], reason: "catalog joins over task status" },
  loader: …,
});
```

- `reads: { tables, reason }`.
  - `tables` are drizzle tables, views or rollups.
  - `reason` is required and non-empty, and it shows in the Read-set pane.
  - On values with params, the reason states why a write to any row may change any tuple, or names the follow-up that narrows it.
- **Required on the `db` arm** (tsc), at the end of the round. Optional on the `external` arm: an external that queries the DB declares it, and the `no-db-backed-notify` check accepts a declared one. This replaces the policy "externals never read the DB" with "they may, if they declare it".
- **Registry-computed reads** use a thunk, `tables: () => [...]`. This covers `event-triggers` (one table per trigger event), `icons.saved-sprites` (per `SavedIconSource`, which gains `tables`) and `attachments.by-owner` (one link table per owner type, plus `attachments`). The value is then bound at `bindDeferredResources`, after contributions and before the change feed builds triggers.
- Only the Bun server wrapper accepts `reads`: central, browser-server and paged values have `reads?: never`.

### Compile (layering)

- `network/live/core`'s `compileValueOf` is host-agnostic, so it cannot import query-resource. The Bun wrapper (`network/live/server/internal/serve-value.ts`) injects a `compileReads` seam.
- It calls a new `compiledValueReach(reads)` in `infra/query-resource/server/internal/routes.ts`, the only module allowed to mint plans (the `resource-runtime:compiled-routes` check).
- Output: one `full` route per base table, `columns` = every column (so no update-skipping gate), no `match`, and `map.full.reason` = the declared reason.

### Views and rollups

A whole read naming a relation is expanded through `relationBases` (C30: a view becomes its tables, transitively; a rollup becomes its sources). That graph is injected by change-feed in `onReadyBlocking`, after binding. So the plan carries **relation reads**, and the runtime expands them when it indexes routes, memoized on the bases version as the legacy inversion is. The A8 guard expands captured relations the same way. No loader is rewritten.

### Runtime changes (`resource-runtime`; framework: needs the user's approval)

1. **`reach` beside `dependsOn`.** `attempt-work`, `commits-graph.graph` and `icons.saved-sprites` use `recomputeOn`, which compiles to `dependsOn` (toSubscribed, or a `{}` map).
   - Today the refusal (`runtime.ts:3069`) exists because a cascade's FULL would override a scoped refill. A `ReachPlan` has no scoped refill, so the reason does not apply.
   - Edit sites: the type at `:785`, the throw at `:3069`, and the comments at `:358`, `:373` and `:767-778`.
   - The routed `recomputeOn` edge does not fit: it needs `routes` and is pinned to one upstream tuple.
2. **`reach` on an external resource.**
   - Edit sites: the external types (`:605`, `:621`, `:672-676`) and the throw (`:3060`).
   - The pane: `debugPolicyOf` returns `external` first, so `computeCeiling` (`debug/read-set/web/internal/ceiling.ts:106`) must read `routes` and drift whatever the policy is.
3. **A5 narrowed.** A reach entry may be a cascade upstream (`edited-files` → `review.plugin-changes`); only a `routes` entry may not.
   - A5 was about a downstream reached twice through a routed upstream's tables.
   - A reach upstream's cascade carries its own notify, and the downstream declares its own reads.
4. **A8 fails open.** In production, a captured table outside the declared reads is reported once, and from then on it is routed FULL to that entry as an implicit whole read. The value is therefore never staler than under today's router. Tests still throw (`strictRoutes`).
5. **Relation reads** (above). Also fix the stale comment at `routing.ts:288` ("a non-keyed entry is never L2-persisted"): `notifications.unread` and `icons.saved-sprites` are persisted reach values.
   - Persisted values stay definitionless (NULL matches NULL in the L2 usable-row predicate).
   - Catch-up already replays through `routeChange`, and `routedTargets` adds the persisted `{}` tuple.

### Behaviour differences to check per value

- The legacy router reloads the `{}` tuple of a value **no one subscribes to**. The routed one reaches only subscribed tuples and persisted entries. Unsubscribed, non-persisted values hold no state, so this should be harmless. Audit each param-less value.
- The skip ack: a whole read never skips a tuple of a table it declares, so the "early ack on a split burst" hole the review found does not arise in this round. It does apply to the follow-up's compiled narrowing, as it already does to collections.

## Sessions

1. **Framework, then all 30 db values.**
   - Spelling: `reads` optional at first, plus the thunk form.
   - The injected compiler.
   - Runtime changes 1–5, and the pane fix.
   - Tests:
     - `routes.test.ts`, for `compiledValueReach`;
     - `runtime-table-routing.test.ts`, covering `reach` + `dependsOn` (cascade and change in one flush = one load), `reach` on an external with acks, A5 narrowed, A8 fail-open, a relation read expanded, and a persisted reach value replayed by catch-up with no subscriber;
     - `compile-value.test.ts`, for the type refusals.
   - Migrate the 30 db values: mechanical, each `reads` taken from its live `readSetBases` / classification, with a reason.
2. **The 11 externals, then delete.**
   - Externals declare `reads`.
   - `no-db-backed-notify` accepts `reads`, so its 8 debt entries go. Close `task-1791766351-ziteb8` and `task-1791766493-c5sz9f`.
   - Make `reads` required on the `db` arm.
   - Gate: `_debug` on a build of this branch shows no `legacy-full` policy and an empty `legacyReach` everywhere.
   - **Delete:** `applyLegacyFullChange`, `tableToResources`, `legacyRouted`, `legacyReach` and the `legacy-full` policy (runtime, `resources-debug.ts`, the pane's Legacy FULL section), the `legacyFull` test helper (its suites move to routed fixtures), `boot-init.ts`'s read-set seed, and `read-set-shrink`.
   - **Keep:** the per-run capture (A8), `relationBases` (relation reads, A6), the `tables_read` column (A6 guard tables), and the notifications reconcile.
   - Update the docs: the CLAUDE.md of resource-runtime, server-core, network/live, change-feed, live-state-snapshot and debug/read-set.
3. Not this item: the next track item, **compiled narrowing**. Values whose payload is rows become collections, which needs composite-key collections. Computed values follow collection rows, which needs a new "value follows a collection tuple" edge. Measure `deliver:page-blocks`, attempt-work and commits-graph loads before and after.

Two sessions instead of three: session 1 is mechanical after the framework part, and the deletion needs main to have run session 1 first, to confirm `legacyReach` is empty in production.

## Verification

- `./singularity test` on resource-runtime, query-resource, network/live, change-feed, live-state-snapshot, debug/read-set and each migrated plugin. `./singularity check` clean.
- After each build: the dumped `/api/resources/_debug` shows, per migrated key, `policy: "routed"`, routes equal to its former `readSetBases`, and an empty `routeDrifted`.
- e2e: with a page open, edit a block. `page-blocks` still updates, and `notifications.unread` still updates on a new notification. Check Debug → Read-set: the Routed FULL list shows each value's reason, and the Legacy FULL section is gone after session 2.

## As landed — session 1 (2026-10-16, worktree `att-1792063907-cm5aav`)

**Scope moved:** relation reads, `reach` on externals and the narrowed A5 went to session 2 with the externals that need them. The 30 db values read base tables only (the live `_debug` showed views only in externals' read-sets).

**Framework**
- `serveValue({ source: "db" })` requires `reads: { tables, reason, outsideFeed? }` or a thunk (tsc + a throw at registration). Compiled in the Bun wrapper (`network/live/server/internal/serve-value.ts`, `valueRuntime`) by query-resource's `compiledValueReach` (`routes.ts`): one `full` route per table, every column, `usesOf` constant. A thunk registers through `defineDeferredResource`. An empty table list is allowed (a registry holding none); views are refused.
- `outsideFeed` → `ReachPlan.unfed` (`UnfedRead`): accepted by the drift guard, `unfedResourceTables()`, `_debug.unfedReads`; change-feed's `assertUnfedTablesOptedOut` blocks boot on one the feed covers. Needed by chord.catalog / chord.progress (the song-index windows, read through a memo).
- resource-runtime: `reach` may sit beside `dependsOn` (only `routes` refuses it); A8 **fails open** in a running server — a drifted relation's bases (expanded through `relationBases`, so a view drift lands on its tables) join `routedByTable` for the entry and recompute FULL.
- Chip referents: `InlineTokenReferentSource` gained a required `tables`, threaded through `idChipServer` (9 chips + inline page link); the attempt / conv / task-link resolvers read base tables instead of the views; `inlineTokenReferentTables()` feeds page-backlinks' thunk. `SavedIconSource` gained `tables` the same way.

**Migrated: 31 values** (30 + `task-subject.by-subject`, new on main). Every declaration was written by one agent and checked against the loader's SQL by an independent one. Thunks: `event-triggers`, `icons.saved-sprites`, `attachments.by-owner`, `page-backlinks`.

**Verification**
- Tests: 88 bun + 15 vitest files across resource-runtime, query-resource, network/live, change-feed, active-data, inline-chip, page/links — green. New: reach beside dependsOn (one load per flush), A8 fail-open (a drifted view reaches through its bases, not its own name), unfed (accepted under strictRoutes; mint refusals), `assertUnfedTablesOptedOut`, `compiledValueReach`, `serveValue` reads (required / refused on external / thunk binds on its runtime with its routes).
- Deployed worktree: `_debug` shows 210 routed, 77 external, **0 legacy-full**, 0 `legacyReach`; every one of the 31 values loaded over HTTP with real params, and **`routeDrifted` stayed empty** — no declaration misses a table its loader read.
- Not measured: a live write's delivery per value (the routing itself is pinned by the runtime suites; values are whole-table, so delivery equals the legacy router's).

**Known limits (follow-ups)**
- A8's fail-open is in memory: a persisted reach value (`notifications.unread`, `icons.saved-sprites`) that drifted forgets it across a restart until the next load drifts again (the L2 `tables_read` seed only feeds the legacy index). Moot once declarations are complete; delete with the legacy index in session 2 or seed `drifted` from `tables_read`.
- No performance change by design: page-blocks, attempt-work, commits-graph and the externals on `conversations` still reload on any write to their tables — the compiled-narrowing item.
