# Resources track: declared reads for database-backed live values

Track: Network Layer › Resources (page `block-f64cfc08-6ec6-4ef3-9122-f143cc24798e`), item "Routing for DB values" / [9] "delete the legacy read-set router".
Prior: `research/2026-10-13-global-live-latency-in-slow-ops.md` Part 1.

**Status: SUPERSEDED by `2026-10-15-global-live-declared-reads-for-db-values-v2.md`.** Review found that a hand-written `match` can silently miss rows (A8 is table-level). v2 drops it: hand-written loaders declare whole-table reads only, and row narrowing comes from compiled queries.

## Context

Every live collection is routed: a write reloads only the rows and tuples it touches. Values are not. A `serveValue({ source: "db" })` is typed `reach?: never` (`network/live/core/internal/compile-value.ts:351`). It is reached by the legacy read-set router, `applyLegacyFullChange` (`resource-runtime/core/runtime.ts:7146`). That router fully recomputes every subscribed tuple of every value whose captured read-set holds the written table. External values whose loaders read Postgres are reached the same way (`legacyReach`).

Re-count at HEAD (`11b411d9ff`): **30 `source: "db"` values, plus 8 external values that read feed-visible tables** (the 8 `no-db-backed-notify` debt exemptions). That is 38, against the doc's 29 + 6.

Examples of the cost:
- `page-blocks`: every keystroke flush on any page reloads every open page's whole block forest.
- `commits-graph.graph` and `attempt-work`: every `conversations` status write re-runs git for every open attempt.
- `review.plugin-changes`: every `conversations` write re-diffs the plugin tree for every open review pane.

**Goal.** Every DB-backed value declares what it reads, compiled into the runtime's existing `ReachPlan`. Then delete `applyLegacyFullChange` and its inversion.

**Restated exit criterion** (replaces "every database-backed read is routed; … nothing legacy-full except declared external sources"):

> Every DB-backed read is routed through a declared plan. A collection's plan is compiled from its query. A value's plan comes from its declared `reads`: each read either matches a tuple by its params, or is whole-table with a stated reason. The Read-set pane has no "legacy-full" policy, and `applyLegacyFullChange` is deleted.

## What already exists (no new runtime concept needed)

- **`ReachPlan`** (`resource-runtime/core/routing.ts:283-312`) is the non-keyed route plan. Its routes are all `full`, and the per-tuple `usesOf(params)` may return `TupleUse.match`, a `{column → value set}` row filter.
  - `routeTuple` (`routing.ts:456-571`) skips a tuple when no changed row's carried key is in its set.
  - A `U` carries the old ∪ new keys, so a row moving between hosts matches both.
  - Unknown keys (`keys: null`: a producer table, an over-cap statement) make the tuple FULL, so the router fails open.
- **Trigger layout is derived.** A route's `match` columns join the table's carry set (`tableLayoutRequirements`), and change-feed installs the richer trigger. Boot checks A3 (`route-layout.ts`) and A1′ (`route-coverage.ts`) verify it.
- **The A8 drift guard** (`checkRouteDrift`, `runtime.ts:2502`) applies to every routed entry. Each run, the loader's captured tables must be a subset of its route tables. It reports once in production and throws under tests (`strictRoutes`). This answers the objection the 2026-09-20 doc raised against hand-declared reads, "declared-then-drifted".
- **The Read-set pane** already lists every routed `full` route with its reason (`RoutedFullSection`). That is where whole-table reasons show.
- **The precedent:** collection `:groups` and counts already serve as non-keyed values through `compiledReachPlan` (`query-resource/server/internal/routes.ts:269`).

## Design

### Spelling: `reads` on `serveValue`

```ts
serveValue(pageBlocksValue, {
  source: "db",
  reads: [{ table: pageBlocks, match: (p) => ({ pageId: p.pageId }) }],
  unbounded: { reason: "one page's forest" },
  loader: …,
});

serveValue(curriculumValue, {
  source: "db",
  reads: [{ table: chordCurriculum, whole: { reason: "singleton row (id = 1)" } }],
  loader: …,
});
```

- `table` is the drizzle table object, as in `serveCollection`'s `from`. It must be a base table. A view, a rollup or a feed-excluded table is refused at compile time, the same rule (A1) collections follow.
- `match: (params) => { [column]: string | readonly string[] }`. Columns are typed drizzle keys of `table`, compiled to SQL names. They compile to `Route.match` (so the trigger carries them) and to a `TupleUse.match` per tuple. The function is pure and synchronous, the same contract as `usesOf`. An empty array is a valid "no rows" answer.
- `whole: { reason }`: no per-tuple filter, so every write to the table reloads every tuple. It is the stated-reason arm of the exit criterion, and the reason shows in the pane's Routed FULL list. A read has exactly one of `match` or `whole` (discriminated union, tsc).
- **No hand-declared column gate in v1.** Each route's `columns` is the table's full column list, so a `U` is never skipped by the gate. A hand-written loader's column use cannot be checked: A8 is table-level. So a column gate would be a silent-staleness footgun with nothing to catch it. It can come back later, behind a check.
- **`reads` is required on the db arm** (tsc). Once migrated, a db value cannot be declared without routing.

### Compile

- `network/live` `compileValueOf` passes `reads` to a new query-resource compiler, `compiledValueReach(reads)`, in `routes.ts`. That is the only place allowed to mint (the `resource-runtime:compiled-routes` check).
- The compiler produces one `full` route per read:
  - `id`: `read:<sqlTable>[:n]`
  - `columns`: every column
  - `match`: the declared column names
  - `map: { kind: "full", reason }`, where the reason is the `whole` reason or `match on <cols>`
- `usesOf(params)` returns `{ role: "value", match }` for a matched read and `{ role: "value" }` for a whole read. It is memoized by the runtime as today.
- `compileValueOf` sets `options.reach`, and `registerValueOf` passes it to `defineResource`.

### Runtime relaxations (framework, `resource-runtime`)

1. **`reach` beside `dependsOn`.** Three db values use `recomputeOn`: `attempt-work`, `commits-graph.graph` and `icons.saved-sprites`. Today `routingRecordFor` refuses `reach` with `dependsOn`, because a cascade's FULL would override a scoped refill. A `ReachPlan` has no scoped refill (every route is `full`), so the reason does not hold. Allow `dependsOn` beside a `reach`, but not beside `routes`.
2. **`reach` on an external resource.** Eight externals read the DB to resolve a path (worktree, transcript chain) or a few catalog fields. Today they are reached through `legacyReach`. Allow a `reach` on `defineExternalResource`: its own `notify` stays the primary signal, and its DB reads are routed as declared. `network/live`'s external arm gains the same optional `reads`. The `no-db-backed-notify` check then accepts an external that declares `reads`, which clears its 8 debt entries. The guard becomes "an external that reads the DB declares `reads`".
3. **No other change.** Persisted values stay definitionless (`ReachPlan.definition?: never`, as today's legacy values). Catch-up already replays through `routeChange`, so routed values are covered.

### Views

Values read base tables only (A1), so A8 compares captured relations against declared tables in one space. Three loaders read a view today:
- `allow-files` and `review.plugin-changes` read `conversations_v` through `getConversation`.
- `automations.catalog` reads `tasks_v` for `status`.

Each gets a base-table read: a small helper over `conversations ⋈ attempts`, and `tasks.status`. That is clearer than expanding views in the guard, and avoids a hot base table such as `conversations` that a view drags in.

### Migration: the 38 values

The classes below come from the 2026-10-15 inventory. Per-value declarations will be finalized in review.

| Class | Values | Declaration |
|---|---|---|
| A: one table, params match a column (or the PK) | page-blocks, active-data.bindings, data-view-custom-values, data-view-row-order, sonata-track-view, agent-notes-authors, attachments.file, history.version, deploy.server-ssh-key | `match` on the param column(s) |
| B: several tables, all matchable by params | attempt-work, commits-graph.graph (attempts.id, conversations.attempt_id, pushes.attempt_id), jsonl-events, background-shell-output, subagent-activity, subagent-transcript (conversation_sessions.conversation_id, conversations.id) | `match` per read |
| C: params match some tables; join hops are whole-table | task-source-url.by-attempt, edited-files, allow-files, review.plugin-changes, events.run-events, attachments.by-owner, page-backlinks, claude-cli.calls-for | `match` where possible, `whole` with a reason on the hop tables |
| D: whole-table bounded, one tuple or aggregate | app-usage.summary, notifications.unread, report-investigations.scope, chord.index-status, chord.curriculum, chord.catalog, chord.progress, mail-sync-state, mail-account, mail-labels, browser-recents, event-triggers, search.results, icons.saved-sprites, automations.catalog | `whole` with a reason |

Special cases:
- `attachments.by-owner` reads `<owner>_attachments`, a table picked by the `ownerType` param. It declares one matched read per registered link table (`owner_id = id` when `ownerType` matches, else `[]`, meaning no rows).
- `event-triggers` and `icons.saved-sprites` read tables enumerated by a registry. Their `reads` are computed from it at serve time, and both registries are complete after boot.
- Still hot after this item, all no worse than today and throttled: `page-backlinks` and `icons.saved-sprites` on `page_blocks` (only result-derived id sets would narrow them), and `search.results` on `search_documents`. Filed as follow-ups, not blockers.

### Deleting the legacy router (end of item)

Once no entry is legacy-routed:
- Delete `applyLegacyFullChange`, `tableToResources` and `legacyRouted`.
- Delete the `relationBases` injection used only for the inversion.
- Delete the `legacy-full` policy and `legacyReach` from the debug API and the pane.
- Delete `boot-init.ts`'s `tables_read` seed of the read-set index.
- Keep the read-set capture: A8 needs it.
- Re-check `read-set-shrink` and `seedReadSetIndex`.
- Tests that use `legacyFull(h, …)` move to routed fixtures.

## Sessions

1. **Framework and the A/B classes.** Spelling, compiler, both runtime relaxations, the pane reason, tests. Migrate classes A and B (15 values).
2. **C/D classes, then delete.** View rewrites, migrate classes C and D (23 values), make `reads` required, delete the legacy router and its debug surface, update the track header and docs.

## Verification

- Unit tests:
  - `query-resource` `routes.test.ts`: `compiledValueReach` output.
  - `resource-runtime` `runtime-table-routing.test.ts`: a value tuple skipped or reached by match, `reach` with `dependsOn`, `reach` on an external.
  - `network/live` `compile-value.test.ts`: type-level refusals.
- Each migrated value's existing tests run under `strictRoutes`, so an undeclared table read fails (A8).
- e2e: edit a page block with two pages open. Debug → Slow Events shows the `deliver:page-blocks` count, and the read-set pane shows page-blocks as routed, matched on `page_id`. The other page receives no frame.
- The Read-set pane lists no legacy-full entry. `./singularity check` is clean, `no-db-backed-notify` has 0 debt, and `./singularity test` passes on the touched plugins.
