# Scoped change routing P8, v3: execution plan for steps 16a–24

**Status:** this plan supersedes the P8 sections of `research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md` (§ "P8 (steps 16–24)", "New assertions", "Verification", "Risks") for implementation. It does not supersede the v2 decisions.
**Verified at:** HEAD `dece612040`, after 7–14 landed in `23a73ac070` and `4008c797a9`. Every `file:line` below is current at that HEAD. Where v2 and this doc disagree, this doc wins.
**Approvals:** the v1 Decisions and v2 Defaults D10–D23 are user-approved and remain in force. No decision is re-opened. One citation (D16) is corrected. §9 adds D24–D30, which can be overridden at approval.
**Provenance:**
- Six area mappers checked every v2 P8 claim at HEAD; one of them ran read-only `query_db` / `get_runtime_profile` on main.
- One adversarial reviewer per area.
- One synthesis, then a completeness critic. The critic's fixes are folded in, marked **(K)**.

---

## 1. Context: what is still wrong (verified)

| # | Defect | Where (current lines) |
|---|---|---|
| W1 | Persisted non-membership entries (`tasks`, `attempts`, `agent-launches`, `task-categories`) always reload FULL. | `resource-runtime/core/runtime.ts:4845` `const scoped = affected !== null && !persisted;`. `isPersisted` is at `:4777-4783`. |
| W2 | On the identity origin, an insert or delete to these entries is FULL. | `runtime.ts:6610-6612` (`else { affected = null; }`). The edge-covered `continue` is at `:6613-6618` and the uncovered FULL at `:6620-6624`. |
| W3 | C1: a push makes `pushes.attempts-cascade` FULL, then `attempts`, then `tasks`. `tasks_v` also reads `pushes` and `conversations` **directly** (confirmed through `view_table_usage`), so view forwarding makes `tasks` FULL independently of the cascade. | `tasks-core/server/internal/resources.ts:164-169` (cascade), `:171-254` (attempts), `:266-314` (tasks). `views.ts:282-305` (the `task_waiting` and `task_completed_push` CTEs). |
| W4 | View forwarding: any write to a task or attempt makes `conversations-active`, `-system` and `-gone` FULL. | `change-feed/server/internal/route-change.ts:65-123`, with `dependentViews` at `view-deps.ts:58-71`. A non-identity view gets `op:'U', ids:null`. |
| W5 | Any DELETE in a membership drain cascades FULL. | `runtime.ts:4472` (`deletedIds.size > 0 ? null : requestedIds`). The cascades are at `:4217-4225` and `:4466-4488`, with a second call at `:4579`. |
| W6 | The legacy machinery is still live. | `rel()` is in `query-resource/server/internal/rel.ts`. `coveredOriginsFor` is at `runtime.ts:2024-2050`. View forwarding is W4. `identityTable` is on the `View` uses at `tasks-core/server/index.ts:250,251,256`. `keyedResourceDescriptor` is at vocabulary `:216-220`. |
| W7 | The Read-set pane under-reports. `readSetBases` maps each view to its single identity base (`runtime.ts:6141-6177`), so `tasks_v` appears as `tasks` alone. | `read-set/web/components/read-set-view.tsx:117-164` (`computeCeiling`). |
| W8 | `task_latest_conversation` goes stale when an attempt is cascade-deleted. **The root cause is verified:** the maintain function resolves tasks through `FROM attempts a WHERE a.id = ANY(...)` after the attempt row is already gone. | `agents/server/internal/rollup-spec.ts:52-54` and `:67-69`. The completeness comment at `:16-18` is wrong. |
| W9 | `useConversation` cannot find a done conversation older than the newest 30. | `conversations/web/use-conversations.ts:71-95`. Two REST fallbacks hide the gap: `use-conversations.ts:199-233` and `conversation-view/web/panes.tsx:25-68`. |

Additional facts measured on main (`query_db`, 2026-10-06):

- **The catch-up backstop fires on every main boot today.** The `agents` L2 row is at position 26389329; the oldest retained changelog xid is 27698316. Any cold-boot number taken before 16a is therefore a backstop number.
- **Rollups are rewritten wholesale on every boot.** Total `n_tup_upd` is 7.1M (`task_latest_conversation`), 7.3M (`attempt_conv_agg`) and 5.4M (`attempt_push_agg`). Over the same period `conversations` had 15.6k updates. The cause is a reconcile that is `ON CONFLICT DO UPDATE` with no diff guard.
- **Row counts:** tasks 5027, attempts 4681, conversations 4881, pushes 4103, task_dependencies 1817 (closure **12,224 pairs**; v2 said 12,115/1,807), agent_launches 29, tasks_ext_category 3004.
- **L2 sizes:** tasks 612 KB, attempts 592 KB, task-categories 56 KB.

## 2. Carried over unchanged from v2 (by reference)

- Decisions v1 and D10–D23, with the D16 citation fix in §3.
- The 16b SQL-shape table (Full, Scoped, orderIds, dependents probe, jsonAgg), the measured costs, and the CTE-name rule A38.
- The route table for the rollup, children and closure kinds. Changes are in §3 C9–C11.
- The fingerprint inputs (A18/A40) and A30.
- Assertions A29–A40, and revised A18/A20/A21/A27/A28, except A36, which is dropped (§3 C14).
- The tests list for 16b and the oracle list for verification.
- The step 18–22 shapes in the v2 table, except where §6 amends them.
- The D20 lint group and the Known limits.

## 3. Changes against v2

| ID | v2 claim | Reality at HEAD | Fix | Sev |
|---|---|---|---|---|
| C1 | 21: the attempts source fires `AFTER DELETE / UPDATE OF task_id`. | Postgres rejects transition tables on a trigger that has a column list, and every maintain reads `old_rows`/`new_rows`. | Generate `AFTER UPDATE` with no column list. Filter inside the maintain: `old_rows FULL JOIN new_rows ON pk WHERE ROW(reads) IS DISTINCT FROM`. Guard the upsert `DO UPDATE … WHERE ROW(t.*) IS DISTINCT FROM ROW(EXCLUDED.*)`. | **BLOCKER (as written)** |
| C2 | 16b: `all` is a new `ArmMode`; ArmPlan is consumed "unchanged". | ArmPlan renders are drizzle `QueryStep` builders (`arm-plan.ts:127,139-143`). The `all` shapes are raw SQL (`QueryDb.execute`). The union already bypasses `planArm` (`compile-union-window.ts:39,446,464,477`). | **Do not add `{kind:"all"}`.** Ship `compile-alias.ts` and `grouped.ts` as a sibling compiler that reuses the routed half (`routedReads`, generalized). See §4.1. | major |
| C3 | Entry point: a third overload of `windowQueryResource` / `deferredWindowQueryResource`. | One compile must mint `key` and `key:rows` from the same aggregates. `deferred` is moot because `all` cannot be contributed. | `compileAllCollection(contracts, spec) → { all, rows, keyField, definition }` serverOpts, exported from `query-resource/server`. It is not a register marker, so the vocabulary check is untouched (`resource-vocabulary/check/index.ts:51-83`). | major |
| C4 | `serveCollection` binds `all` eagerly. | The impl dispatches `collection.window === undefined` → lookup-only **first** (`serve-collection.ts:978`). An `all` collection would silently be served as lookup-only. | Add the `all` branch **before** `:978`. Throw if `all` reaches the contributed or columnScope path. Test that both keys register. | major |
| C5 | Step 22 builds `all` over `_conversations` and the owner joins. | v2's `all` join kinds are rollup, children and closure only. The owner joins are required INNER `lookup`s (`conversation-owner.ts:24-41`), which today compile only in compile-window. | 16b.5 adds `lookup` (required INNER) to the Full, Scoped and orderIds shapes. It reuses the step-13 reverse routes and gates, with parity cases. Without this, step 22 cannot be built. | major (blocks 22) |
| C6 | 16b.1: only `anyOf` moves out. | There are two divergent `= ANY` helpers: `anyOf` (`joins.ts:933-935`) throws on a bad id, `idsIn` (`compile-union-window.ts:312-317`) drops it. The union also has private `TYPE_ALIASES`, `canonicalSqlType`, `nullOf`, `decoderOfRead`, `fromSql` and `allOf` (`:200-322`). | Create one `raw-sql.ts` with an explicit invalid-id policy. `:rows` keeps "a bad id is absent". Take a **union SQL+routes snapshot before** touching any of this, because the union is not in the golden. | minor |
| C7 | `readExpressions` gains `{kind:"aggregate"}`, and provenance then works. | `columnsIn` (`joins.ts:633-683`) skips raw and Name chunks, so a CTE read yields no relation column. `expressionOf` (`:390-398`) throws on unregistered SQL. `routeColumnsOf` (`:1087-1110`) assumes one table per relation. | Register `{kind:"aggregate", relation, reads, nullable, sqlType}` and make `columnsIn` descend into `reads`. Make closure internals distinct relations (`<a>`, `<a>__anc`, `<a>__anc__<r>`). Rollup routes come from `src.reads`, not `routeColumnsOf`. Add a bind assert that every projected outer read resolves to at least one relation column. | major |
| C8 | `joinRoute` is replaced by `joinRoutes`; `routedReads` is otherwise reusable. | `routedReads` builds one route per join with id = alias (`arm-plan.ts:261-267`). `tuple()` keys `uses` one-to-one (`:297-320`). | `joinRoutes(join, host, columnsOf): RawRoute[]` plus `routeIdsOf(alias): string[]`, and `tuple()` fans out over the ids. Existing kinds return today's route byte-identically. | major |
| C9 | Only `routedReads` must learn rollup routes. | `planGroupArm` (`compile-groups.ts:116-161`) mints its own full route per join (`:145-160`) with `table = j.spec.table`. A rollup join there would name the rollup table, and A1 would throw at boot. | **Refuse a rollup / children / closure join in a grouping at module eval** (rung 4). P8 has no grouping that needs one. Type it out with a separate `AllJoinSpec` (§4.1). | major |
| C10 | `compile-sql-golden.json` is in query-resource. | It is at `network/plugins/live/server/testing/compile-sql-golden.json`, with its generator `gen-compile-golden.ts` and test `network/plugins/live/server/internal/compile-sql-golden.test.ts`. | Cite the correct path. `derivedReads` is emitted only when non-empty, so the golden stays byte-identical. | minor |
| C11 | Generated `CREATE TABLE ${table}` passes `imperative-create-table-allowlisted`. | It fails: the check is textual (`findOffenders` `:133-145`; `ALLOWED_PATHS` `:40-43` is self-reference only). | At eval, assert `getTableName(handle) ∈ Object.values(IMPERATIVE_PUBLIC_TABLES)`. Add **one evidence-based exemption** for the generator file next to `usesThrowawayTestDb`, not in `ALLOWED_PATHS`. | major |
| C12 | `CREATE OR REPLACE TRIGGER` removes the hot-swap deadlock. | ShareRowExclusive conflicts with the RowExclusive that writers take. A multi-table hold inside the single schema-layer transaction (`migrations/server/internal/runner.ts:380-416`) can still hit 40P01 against an old backend's attempts→conversations write. | Install trigger DDL **one source table per savepoint, in a fixed table order**, only when the definition signature changed, mirroring `change-feed/server/internal/triggers.ts:688-700`. Run the reconcile after all savepoints. | major |
| C13 | Reconcile counts go into a module map behind `reconciledRollups()`. | `rebuildDerivedTables` also runs in the dry run (`commit:false`) and in `schema-layer-replay.test.ts`, so a map written inside the transaction could report heals that rolled back. | `rebuildDerivedTables` **returns** `{table, upserted, deleted, definitionChanged}[]`. `applySchemaLayer` threads it out. The committing call (`database/server/index.ts:57-69`) publishes it after commit. | minor |
| C14 | A36 is a new assertion. | A3 already covers it: `assertRouteLayoutsInstalled` (`install-feed.ts:80`) and `resolveLayout` (`triggers.ts:560-587`). | Drop A36. Add a test that a rollup-source route (`attempt_id` on conversations) appears in `routedTableRequirements()` and is checked by A3. | minor |
| C15 | 16b.3: the scanner `mintsOf` is a parse change. | `requires` is a single presence gate (`vocabulary.ts:94`). The suffix-`""` mint requires `default` (`:233-241`). `eager-tier-gen.ts:375-377` ignores `requires`, so it would push `key` twice. | Add mint `{suffix:"", keyed:true, membership:null, preloadable:true, requires:"all"}`. Use one `mintsOf(entry, argsText)` (depth-0, like `declaresOnDemand` `parse-resources.ts:185-202`) in **both** `parse-resources.ts:161-168` and `eager-tier-gen.ts:375-377`. Assert that no two kept mints share a key. | major |
| C16 | `liveCollection(key,{all})` mints `key` and `key:rows`. | Any spec without `default` falls into `rowsPart` (`live-collection.ts:400-455`). `WINDOW_FIELDS` (`:460-469`) lacks `all`. | Add the `all` branch first. Add `all?: never` on the three spec types (T13). Throw on `all` combined with `default`, `arms`, `filterable`, `sortable`, `maxLimit`, `scroll`, `contributed` or `columnScope`. Add an internal `allResourceDescriptor` and `AllQueryResourceContract<Row>` in `query-resource/core`. | major |
| C17 | `useLive(all)` reads through `useResource`; the latch "starts from the cache". | The non-value path goes to `listShape` → `collection.window.window` (`use-live.ts:112`). The latch is in `primitives/live-state/web/use-resource.ts:501-600`. Initializing from the cache only covers mount, not a params change. | Add `LiveAllCollection<Row>` (no `live` field, `window?: never`). Place the overloads **after** the window and group overloads (`use-live.ts:154-157`). Dispatch to `useResource(allDescriptor, undefined, {gate:true, select?})`. Make the latch **derived**: `settledKey === keyStr || queryClient.getQueryState(queryKey)?.dataUpdatedAt !== 0`. | major |
| C18 | D16: "the option does not exist (`spec.ts:178`)". | `debounceMs` exists on the compiler (`spec.ts:189,391`, forwarded at `compile-window.ts:247,284,330-331`). What is missing is a `serveCollection` option. | Re-cite D16 as "`serveCollection` has no throttle". `compileAllCollection` accepts `debounceMs?`, mapped from a `throttleMs` option as in `compile-value.ts:331`. | minor |
| C19 | 16a: the floor is the BigInt-min of the drain watermarks; undefined poisons the window. | A scoped refill reads only the requested ids, so the drain-start W can miss an unrouted commit with xid < W. The same hole exists today at `runtime.ts:4256-4267` and `:4520`. | Use **baseFloor** per (entry, pk). Set it at the FULL drain (flight watermark), at the sub-ack seed (`gatedRead` watermark, `:5556`/`:5597-5601`), and only in the **actually-seeding** branch of `seedPersistedSnapshot` (`:6802`). Floor = `LEAST(stored, baseFloor)`. Delete the per-drain `captureWatermark`. | major |
| C20 | Catch-up backstop: recompute and skip seeding. | The seed (`live-state-snapshot/server/index.ts:118-134`) runs **before** `runCatchUp` (`:145`), which decides the floor and backstop (`catch-up.ts:118-156`). | Split out `probeCatchUp` and run it before the seed. See §4.2 for the onReady order. Delete `fullRecomputeChangedTables` (`catch-up.ts:186-203`). | major |
| C21 | Floor mode passes `tablesRead=[]` to the A6 guard. | The produced-guard checks `tablesRead` (`produced-guard.ts:113-122`), so `[]` admits a first floor INSERT of a key that reads a produced table. | The hook argument becomes `{mode, definition, guardTables}`. Floor mode guards on the readSet union or the route tables but **does not write** `tables_read`. | major |
| C22 | `definition` is a plain column. | Old-code upserts (`persist.ts:108-136`) leave new columns untouched, so a hot-swap writer leaves a stale definition. | Add a `definition_at timestamptz` with **no default**. The read predicate includes `definition_at IS NOT DISTINCT FROM persisted_at`, so an old-shape write invalidates itself. Test: an old-shape upsert after a new-shape upsert fails the predicate. | minor |
| C23 | A18 bounded-key leak, raised as a blocker in the mapping. | It is real: boot-snapshot reads L2 for bounded preloaded keys (`handle-boot-snapshot.ts:53,84,114-120`), and the sweep (`boot-init.ts:55-58`) runs once. The hole already exists for every key migrated to bounded, so no Decision is affected. | 16a: every L2 read is restricted to `resource_key = ANY(persistedKeys())` plus the predicate. Keep-keys for the sweep become `persistedKeys()`, which also excludes externalSource. Land this before step 22 turns `-gone` into a window. | major |
| C24 | Step 19: add `taskDescriptions`; the getTask refetch is unchanged. | A per-id `taskDetail` liveValue already exists (`tasks-core/core/resources.ts:52-55`, served `server/internal/resources.ts:322-332`, declared `server/index.ts:240`) over `tasks_v`. Its one reader is `task-description.tsx:78`. | `taskDescriptions` **replaces** `taskDetail`. Delete the value, the served value, the declare and the core export (`core/index.ts:48`). Update the doc example at `network/live/core/internal/live-value.ts:228`. | major |
| C25 | 22: `recovery-view.tsx:59` moves to by-id. | It subscribes only to invalidate a REST page of 50 (`:26`, `:76-81`). No id lookup happens there. | `useLive(conversationsGone, {limit: 50})`. `-gone` needs `maxLimit ≥ 50`. Delete the useQuery and the invalidate hack. | minor |
| C26 | 22 names two readers. | There are 18 `useResource` sites over the three lists: `use-conversations.ts` (12), `conversation-view/web/panes.tsx` (3), `use-queue-rows.ts:82-83`, `recovery-view.tsx:59`. Gate-slices `:140-176` feed destructive defaults. | Use the full reader list in §6, step 22. Move the gate-slices to `useLive(active,{select})`. | major |
| C27 | D18: the nested `latestConversation` is the only wire change. | The row also carries the flat `latestConversationStatus` (`agents/core/schemas.ts:44`), read at `agent-status.tsx:31` and `agent-detail.tsx:99`. It is plain text in the rollup. | Declare it as a nullable rollup column decoded by `ConversationStatusSchema.nullable()`. `latestConversation` becomes `CASE WHEN latest.task_id IS NULL THEN NULL ELSE json_build_object(...) END`. | major |
| C28 | Steps 20 and 22 delete `conversationCascadeSignatures` and `TRANSIENT_CONVERSATION_FIELDS`. | Both die at step 21, because the agents `rel()` (`agents/server/internal/resources.ts:11,85`) is their last user. The `conversationsView` export (`tasks-core/server/index.ts:42-46`) dies too, and v2 never deletes it. | Delete all three at step 21. | minor |
| C29 | Step 23: every upstream is external (lists `configValues` and `customColumnDefs`). | `configValues` is not an upstream at all. `customColumnDefs` is a routed recomputeOn (`custom-columns/scoped-columns.ts:63`). The real DB-backed `dependsOn` upstreams are all inside the tree deleted by steps 18–22. | Correct the list. Narrow T15 at rung 2 across **three** `AnyServed` copies: `network/live/shared/compile-value.ts:60`, `server/internal/serve-value.ts:54`, `central/internal/serve-value.ts:34`. Add a buildEntry throw beside `runtime.ts:3080`. | major |
| C30 | Step 23: `setRelationBases(fn, version)` maps rollups to sources. | Rollup sources come from `defineRollup` data. That covers every rollup only once all three are converted, including agents' `task_latest_conversation`. A static version opt freezes at construction, because the runtime is built at server-core module eval. | 16b.2 exports `rollupSources(): Map<rollup, sources[]>` for **every** rollup. The runtime opts are call-time closures, `relationBases: r => holder.fn(r)` and `relationBasesVersion: () => holder.version`. The memo signature is `${size}:${readSetVersion()}:${relationBasesVersion()}` (`runtime.ts:1990`). | major |
| C31 | A7: the pane under-reports, so `tables_read` is a catch-up risk. | Refuted. `tables_read` stores view names and catch-up replays through `routeChange`, which expands views. Only the **pane** is dishonest. | The pane expands transitively (§6, step 24). No `tables_read` vs `pg_depend` assertion. | minor |
| C32 | 23: removing view forwarding makes conversation writes FULL-reload the `*_v` readers (gate: re-point `conversationsGoneStats` first). | Overstated. `tasks_v` and `conversations_v` already receive those writes through `view_table_usage`. The new reach is only the rollup hops: readers of `attempts_v`, `task_blocking_v` and `task_latest_conversation`. | Pre-23 gate: dump the legacy-full readers whose read-set includes those three relations **without** `tasks_v`/`conversations_v`, and measure only those. Re-pointing `conversationsGoneStats` stays in step 22 as a cost cut, not a gate. | minor |
| C33 | Step 24 test: "jsdom test of `computeCeiling`". | It is a private pure function (`read-set-view.tsx:117`). | Extract it to `read-set/web/internal/ceiling.ts` and test it with bun `ceiling.test.ts`. | minor |
| C34 | Step 24 depends only on 23. | `definition` and `position_at` do not exist at HEAD; both come from 16a. | State the dependency explicitly: 24 needs 16a. | minor |
| C35 (K) | Step 19's view rebuild only changes forwarding. | Once `tasks_v` reads the rollups (`has_waiting_conv`, `min_push_at`), `view_table_usage` drops `conversations` and `pushes`. Rollups are feed-exempt, so a legacy live reader left on `tasks_v` goes **silently stale** until step 23's `relationBases`. | Step-19 gate: after the rebuild, `_debug` must list no live entry whose raw read-set contains `tasks_v`. If one remains, pull the rollup→source expansion (C30) forward into step 19. Confirm that `page/annotations/todo/task-link/server/internal/annotations.ts:4,42-44` (`tasksView`) is reached by no live loader. | major |
| C36 (K) | The C32 gate is abstract. | `commitsGraphServed` (`conversation-view/plugins/commits-graph/server/internal/resources.ts:61-70`) reads `getAttempt` → `attempts_v`. After 23, every conversation write (`waiting_for` included) would FULL-recompute each subscribed commits graph, which does git work. | Step 20: add `getAttemptRow` over `_attempts` and use it there and at `attempt-work/server/internal/work.ts:60`. | major |
| C37 (K) | 23 drops the drain cascades safely. | `cascadeDownstream` (`runtime.ts:3913+`) also carries `routedRecompute` / `toSubscribed` / `map` edges. | In the same commit, add a buildEntry throw: "a membership entry has no downstream". Add an oracle for W5 (a DELETE in a membership drain with a value-aware downstream): green before 23, refused after. | major |
| C38 (K) | C30 memo signature `${size}:${readSetVersion()}:${relationBasesVersion()}`. | `tableToResources` disables caching when `readSetVersion` is undefined (`runtime.ts:1990-1992`). | Keep that `null` branch. | minor |
| C39 (K) | `all` keys hydrate from the boot snapshot. | Hydration resolves through `resourceDescriptorByKey`. | `allResourceDescriptor` self-registers under `key` (not only `key:rows`). Test: boot-snapshot hydrates an `all` key, and `useLive(all)` renders without a loader round-trip. Check that an old-bundle tab subscribing to the old `tasks` descriptor surfaces as `skew` in the `resource-protocol` verdict, not as a parse error. | major |

## 4. Resolved open items (carried from the ★15 checkpoint)

### 4.1 ArmPlan reconciliation for `all` (decided by the code, not by preference)

The contract that is actually shared is the **routed half** (`routedReads → {routes, tuple}`). Each compiler renders its own SQL, as the union already does. The landing order:

```
query-resource/server/internal/
  raw-sql.ts       anyOf/idsIn (explicit invalid-id policy), fromSql, allOf, decoderOfRead, canonicalSqlType, nullOf
  joins.ts         AllJoinSpec kinds → same JoinPlan; aggregate readExpressions; joinRoutes()/routeIdsOf()
  arm-plan.ts      routedReads uses joinRoutes/routeIdsOf; export RoutedReads<P>; ArmMode UNCHANGED
  grouped.ts       GROUP BY CTEs, jsonAgg (A39), rollup reads, recursive closure / fenced lateral, dependents probe
  compile-alias.ts compileAllCollection({all, rows}, spec) →
                     { all:  opts & { routes, scopedMembership: { orderOf, orderSignatureOf } },
                       rows: opts & { routes, membership: { kind: "point", idsOf } },
                       keyField, definition }   // + optional debounceMs
```

- `AllJoinSpec = JoinSpec | RollupJoin | ChildrenJoin | ClosureJoin | (lookup, already in JoinSpec)`. Only the `all` overloads accept it. `compile-groups.ts`, `serve-union` `UnionArmSpec.joins` and `ColumnOverride`/`JoinColumns` keep `JoinSpec`, so A24 becomes a tsc error.
- `JoinRefs`/`JoinWireColumns` (`core/internal/joins.ts:~211-241`) and the runtime `joinRefs` (`server/internal/joins.ts:221-258`) build the refs for children and closure from the declared aggregates only.
- Amend the stale prose in `arm-plan.ts:41-47`, `compile-window.ts:65-68` and `query-resource/CLAUDE.md:444-458`. Narrowing `assembleWindow`, `assemblePoint` and `compileArmGroups` to one arm is optional cleanup.
- **Prerequisite in 16a:** the routed `scopedMembership` arm (`runtime.ts:546-554`) gains `orderSignatureOf`, and the "Never set on the alias" rule (`MembershipRecord`, `runtime.ts:220-229`) is lifted. The alias's `orderSignatureOf` reads the `orderBy` fields off the wire row, as the union does (`compile-union-window.ts:~762-771`).

### 4.2 16a L2 design (consolidated)

- **Read predicate (every L2 read: boot-snapshot, seed, usable check, catch-up floor):**
  `resource_key = ANY($persisted) AND definition IS NOT DISTINCT FROM ($defs::jsonb ->> resource_key) AND definition_at IS NOT DISTINCT FROM persisted_at`.
- **DDL** (`tables-ddl.ts:17-27` CREATE, `:33-36` ADD COLUMN, `ensureSnapshotTable` `:58-62`): add `definition text`, `definition_at timestamptz` (no default) and `position_at timestamptz`. All three use `ADD COLUMN IF NOT EXISTS`. Existing rows fail the predicate once, which is intended.
- **Persist hook** `{mode:"replace"|"floor", definition, guardTables}`:
  - replace: write `W`, `now()`, `tables_read`, `definition`, `definition_at`;
  - floor: write `position = LEAST(stored, baseFloor)` and keep `position_at`/`tables_read`. On a missing row, INSERT with `baseFloor` and the route tables.
- **Trailing floor window:** 2 s, unref'd, injectable `persistWindowMs`.
  - It is armed only when `changed` (`runtime.ts:4537`) is true; move the persist after that line.
  - Keep a per-(entry, pk) persist promise chain; a successful replace cancels an armed window.
  - Add `dropPendingPersists()`, called from a new `onShutdown` in `live-state-snapshot/server/index.ts`.
- **onReady order:**
  1. usable read (predicate);
  2. `probeCatchUp` (predicate);
  3. **backstop** → clear the persisted rows, run `recomputeResource` on every key in `persistedKeys()`, and return;
  4. otherwise: recompute the unusable keys, seed the aliases (setting baseFloor), then replay from the probe's floor.
- **Boot snapshot:** intersect the keys with `persistedKeys()` for L2. For `unboundedWindowKeys()` prefer `keptSnapshotValue(key)` (new runtime API plus facade), then L2, then the loader. Add `'memory'` to **both** source enums: `boot-snapshot/core/endpoints.ts:41` and `boot-bench/shared/endpoints.ts:8`, plus `aggregate.test.ts:52`. Boot-bench cold mode (`handle-run.ts:102`) bypasses the memory path.
- **Compact job** `live-state-snapshot.compact`:
  - settings: `hold:'instant'`, `dedup:'singleton'`, cron `30 * * * *` (offset from the prune at `:00`), `perWorktree:true`, `maxAttempts:3`; registered beside the prune job (`index.ts:79`);
  - targets: `persistedKeys()` minus the predicate-passing rows with `position_at ≥ now()-1h` (this includes missing rows and NULL `position_at`).

### 4.3 Risk-4 trigger-time baseline: method, and what exists

- **No trigger-time baseline exists on main.** `track_functions` is `none` (superuser context), `track_io_timing` is off, and `query_db` is read-only. No step from 7–14 recorded one.
- **Method (new step 16·0):** a `./equin run` script against the **worktree fork**. Inside `BEGIN … ROLLBACK`, run `EXPLAIN (ANALYZE)` on one representative DML per table. Parse the `Trigger <name>: time=… calls=…` lines; 3 repeats; report the median. The DML set:
  - UPDATE tasks status;
  - INSERT attempt;
  - UPDATE conversations status;
  - UPDATE conversations `waiting_for` only;
  - INSERT pushes;
  - INSERT and DELETE task_dependencies;
  - UPDATE tasks_ext_category;
  - DELETE attempt (cascade plus `task_latest_conversation`);
  - UPDATE attempts.task_id.

  Separately time one COMMIT on throwaway rows, because `pg_notify` cost lands at commit. Re-run after 16b.2 and after each of 18–22. Append the results to this doc's As-landed section.
- **Baselines in hand (main):**

| Metric | Value |
|---|---|
| `EXPLAIN ANALYZE SELECT * FROM tasks_v` | 86.7 ms (1 run; count forms under-report about 40×) |
| tasks loader / attempts loader | 101 ms avg (n=48) / 66 ms avg (n=47) |
| `deliver:tasks` / `deliver:attempts` | 180 ms / 152 ms |
| persist cost | measurable now as `get_runtime_profile(kind='db')`, label `persistSnapshot`; not yet pulled |

- **Installed trigger inventory (the cleanup oracle's starting set):**

| Table | Triggers |
|---|---|
| conversations | `attempt_conv_agg_{i,u,d}`, `task_latest_conversation_{i,u,d}`, `live_state_conversations_{i,u,d}`, `conversations_derive_updated_at` |
| pushes | `attempt_push_agg_{i,u,d}`, `live_state_pushes_{i,u,d}` |
| attempts | `live_state_*`, `attempts_derive_updated_at`; no rollup trigger |
| task_dependencies, agent_launches, tasks_ext_category | plain (non-routed) `live_state_notify` |

### 4.4 D23 check (no subscribed `runs:groups`)

- **Result: inconclusive.** No `runs:groups` label appeared under sub, loader or push in one ambient window on main. The window had no Runs surface open, and main may not have been serving the step-12 code at the time.
- **Resolution:** fold it into ★17. On the worktree deploy, open Runs plain and then grouped. `get_runtime_profile(worktree=<wt>, kind='sub')` and `kind='loader'` must show no `runs:groups`. Record `deliver:runs`.

## 5. Build sequence

| # | Step | Needs | Lands |
|---|---|---|---|
| 16·0 | Trigger-time script and baseline (§4.3); union SQL+routes snapshot test | — | alone |
| 16a | Runtime: alias `orderSignatureOf` + `orderMoved`; `definition` threaded; baseFloor; persist modes; L2 columns + predicate; boot-snapshot memory path; compact job; probe/backstop | 16·0 | alone (hot-swap: no definition-bearing key ships in it) |
| 16b.1 | `raw-sql.ts`; `quotedRelationsIn(sql)` pure export of `database/server` (from `client.ts:188-208`); aggregate `readExpressions` | 16·0 snapshot | golden and union snapshot byte-identical |
| 16b.1a | `within` invalid-id policy: `reverseMap` passes `{ invalid: "absent" }` for `within` (§6, *16b.1a*) | 16b.1 | alone; union snapshot + golden regenerated and the diff reviewed (only reverse-probe `within` clauses of non-text pks may change) |
| 16b.2 | `defineRollup` (C1, C11, C12, C13); `rollupSources()`; convert `attempt_push_agg` → `attempt_conv_agg` → `task_latest_conversation` (conversations source) | 16a | test each conversion on a fork of main |
| 16b.3 | Core: `all` spec, `allResourceDescriptor`, `AllQueryResourceContract`, join types, `aggregate`/`jsonAgg`; scanner `mintsOf` (C15) | — | |
| 16b.4 | `joinRoutes`/`routeIdsOf` (C8); compile-groups refusal (C9); `derivedReads` | 16b.1 | golden + union snapshot byte-identical |
| 16b.5 | `grouped.ts`, `compile-alias.ts`, **lookup in `all`** (C5), fingerprint, golden `all` group | 16b.2–4 | |
| 16b.6 | `serveCollection` `all` branch (C4); fixture-DB oracles; `server/testing` export; **C39 tests** (deferred from 16b.3): boot-snapshot hydrates a synthetic `all` key, and the **old-descriptor `{}` subscription harness** — a param-less old-style descriptor subscribing `{}` against the synthetic `all` entry, asserting the verdict or parse it gets (steps 18 and 19 reuse it) | 16a, 16b.5 | |
| 16b.7 | `useLive` overloads (C17); derived gate latch in live-state; **C39 test** (deferred from 16b.3): `useLive(all)` over a boot-hydrated `all` key renders its rows with no loader round-trip | 16b.6 | |
| 16b.8 | Docs (§6, 16b) | — | |
| **★17** | Benchmark gate plus D23 | 16b | **STOP for review** |
| 18 | `task-categories` | 17 | |
| 19 | `tasks` (+ `taskDescriptions` replaces `taskDetail`) | 18 | |
| 20 | `attempts`; delete the carrier | 19 | |
| 21 | `agent-launches` + the attempts source on `task_latest_conversation` (atomic, A35) | 20 | |
| 22 | `conversations-active`/`-system`, `-gone` window, `conversations.by-id` | 19–21, 16b.5 lookup | |
| 23 | S6 deletions | 22, the C32 gate | |
| **★24** | A7 pane + A26; final review | 16a, 23 | **STOP for review** |

Every step: background `./equin build` and then foreground `./equin await`; `check` green; `./equin test` over the touched plugins.

## 6. Per-step work lists

### 16a: runtime and L2

**Runtime (`resource-runtime/core/runtime.ts`)**
- Add `orderSignatureOf` to the routed scopedMembership arm (`:546-554`), `MembershipRecord` (`:220-229`), the alias normalization (`:3047-3055`), and the ScopePolicy/definition surfaces (`:326`, `:533`, `:552`, `:754`, `:790`).
- In the unbounded branch (`:4434-4454`), run `orderOf` on `entered || orderMoved`.
- Thread `definition`: `RoutePlanInput` (`routing.ts:222-226`) → `mintRoutePlan` (`:278-283`). Add `definition?: never` on `ReachPlanInput` (`:250-255`). Then `RegistryEntry` (`:1036`) and `buildEntry`.
- Add `persistedDefinitions()` beside `persistedKeys()` (`:6759-6765`). Expose `keptSnapshotValue(key)` and `dropPendingPersists()`. Re-export all of them through `server-core/core/resources.ts:439-447` and `index.ts:64-67`, with the hook type at `resources.ts:182-192` and the forwarder at `:366-376`.
- Persist sites:
  - FULL drain: `:4133-4147`;
  - scoped drain: delete `:4256-4267`; replace `:4503-4525` with the floor arm after `:4537`;
  - legacy FULL: `:4934-4960`.
  - Seed baseFloor at the sub-ack `:5597-5601` and in `seedPersistedSnapshot` (`:6793-6804`, seed branch only).
- Add the per-key `_debug` fields `{definition, lastReplaceAt, lastFloorAt, l2PositionAt}`. The pane renders them at step 24.

**L2 (`database/plugins/live-state-snapshot`)**
- `tables-ddl.ts`: the new columns, per §4.2.
- `persist.ts`: upsert `:108-136` with the two modes; `readPersistedReadSets` (`:168-185`) and `readPersistedSnapshots` (`:244-268`) take the expected map and return `{value, position, positionAt}` internally; the public wrapper keeps its shape; `clearSnapshotsExceptKeys` (`:284-303`) uses `persistedKeys()` and deletes predicate-failing rows.
- `boot-init.ts:55-58` sweep keys; `:96-99` A6 guard gets `guardTables` (C21).
- `catch-up.ts:118-203` → `probeCatchUp` + replay; delete `fullRecomputeChangedTables`.
- `server/index.ts:115-145`: reorder per §4.2; add `onShutdown`; register the compact job.

**Boot snapshot and boot-bench:** the memory path, source enums and cold mode (§4.2).

**Tests (fan-out):**
- runtime suites: scoped-membership (5; update the watermark-order assertion), catchup (10), table-routing (3), window-membership (3), stale-flight (1);
- `resource-runtime/core/test-support.ts`;
- live-state-snapshot: `persist.test.ts` (35 refs, + the C22 old-shape case), `catch-up.test.ts`, `produced-guard.test.ts`;
- new cases: a reorder-then-floor value equals the FULL output; a backstop boot recomputes every persisted key; a hot-swap old-shape write is not served; a bounded preloaded key is never served from L2.

**Docs:** the CLAUDE.md files of resource-runtime, live-state-snapshot, boot-snapshot, boot-bench and `debug/read-set-shrink`; `docs/plugins-details.md` via build.

### 16b: the compiler

Work lists are as in §3 (C2–C18) and §4.1. Additional items:
- **Rollups (`derived-tables`):**
  - `defineRollup({table, key, columns, sources:[{table, carry, via?, reads}]})` replaces `DerivedRollupSpec` (`core/internal/types.ts:24-42`).
  - `rebuildDerivedTables` (`server/internal/rebuild.ts:69`) returns its counts.
  - Exports: `defineRollup`, `rollupSources`, `reconciledRollups`.
  - Generated names are `<rollup>__<src>_{i,u,d}`. The legacy cleanup matches only `^(attempt_conv_agg|attempt_push_agg|task_latest_conversation)_(i|u|d)$` and their `*_maintain` functions, never `live_state_*` or `*_derive_updated_at`.
  - Migrate:
    - `install-derived-schema.ts:41-46` (via a new `installRollups(db, rollups)` in `derived-tables/server/testing`);
    - `views.test.ts:78-82`;
    - `rollup-spec.test.ts:50-54`;
    - `runner.ts:311`;
    - `tasks-core/server/testing/index.ts`;
    - `conversations/server/internal/auto-start-launch.test.ts`;
    - `contribution.ts:2`;
    - `migrations/check/internal/schema-layer-replay.test.ts:42-53` (the second apply must still be a no-op).
- **A8 under derivedReads:** compiled aliases read base tables plus rollups, **never** `attempts_v`/`tasks_v`. State this in the step-18 prose. `checkRouteDrift` (`runtime.ts:2268-2284`) accepts a captured rollup read whose sources are all routed.
- **Fingerprint:** render through `PgDialect.sqlToQuery` (the precedent is the `network/live/server/testing` recording DB).
- **Guard message:** `compile-window.ts:310` (plus `:32` and `:516`) now points at `liveCollection(key,{all})`. Update the regex at `network/live/server/internal/compile-window.test.ts:523-528`.
- **Tests:** v2's 16b list, plus:
  - a union snapshot;
  - lookup-in-`all` parity;
  - compile-groups refusal;
  - a define-rollup oracle (an attempts `task_id` move; delete an attempt with the task keeping an older conversation, delete the last attempt, delete the task; a non-read update leaves `xmin` unchanged; a clean reconcile writes 0 rows);
  - a boot-layer writer-order deadlock oracle (C12);
  - a jsdom latch test beside `use-resource-error-gate.test.tsx`.
- **Docs:**
  - the CLAUDE.md files of network/live, query-resource, resource-vocabulary, codegen (`requires`) and derived-tables, including its server barrel description;
  - the `rollup-spec.ts:16-18` comment.

### 16b.1a: `within` invalid-id policy (follow-up to 16b.1)

The gap is the *As landed → 16b.1* "Open gap — `within`" bullet: `within` is not always vouched for (a point reader's is the client's own `:rows` id set), yet `reverseMap` casts it with `{ invalid: "throws" }`, so one key a non-text pk cannot hold (`uuidarm:x`) raises an invalid-input error on every write to the looked-up table and recomputes every bounded `:rows` reader of the entry FULL, with a report each time.
- `query-resource/server/internal/joins.ts` `reverseMap`: `within` → `anyOf(pk, [...within], { invalid: "absent" })`. `changed` stays `"throws"` (the database vouched for it). An empty `within` after dropping still bounds to no host, never to "unbounded".
- Regenerate the union SQL+routes snapshot (`compile-union-window.test.ts`) and the compile-SQL golden (`network/live/server/testing`); review the diff — only `within` clauses of reverse probes over non-text pks may change.
- Oracle test: a union `:rows` reader holding `uuidarm:<not-a-uuid>` plus a valid key, then a write to the arm's lookup table → the reader is routed by scope (its valid key's row recomputes), no loader error, no FULL recompute, no report. The same for a plain keyed collection with a uuid pk.
- Docs: drop the "Known gap" paragraph from the query-resource CLAUDE.md (Raw SQL helpers) and the `reverseMap` comment's gap note; state the policy (`changed` throws, `within` absent).

### ★17: benchmark gate (on the worktree fork; same scripted workload, `tree-live-verify`, before and after)

| Present | How |
|---|---|
| compiled `tasks` full vs `tasks_v` (≈0.45× expected) | 3× `EXPLAIN (ANALYZE, BUFFERS)`, median |
| `attempts` full (D11) | same |
| scoped closure p50/p95/max (D12) | loader spans |
| order-frame bytes (D13) | push frame sizes, entry and move |
| cold boot, L2 swept, **non-backstop** | boot-bench, after 16a fixes the floor |
| closure pairs | 12,224 today |
| trigger time per table | §4.3 script, vs 16·0 |
| rollup churn | `n_tup_upd` **delta across one restart** (not totals) |
| `persistSnapshot` db spans | `get_runtime_profile(kind='db')` |
| catch-up replay volume with a ~1 h floor | changelog rows replayed at restart |
| D23 | §4.4 |

**Stop for the user's review.**

### 18: `task-categories`
- `liveCollection('task-categories', {row: TaskCategoryRowSchema, id:'taskId', all:{orderBy:[['taskId','asc']], unbounded:{reason}}, preload:'boot'})`. Identity: `tasks_ext_category`; it first gets a routed layout here.
- `useTaskCategoryMap` (`web/hooks.ts:29-37`) returns a `ResourceResult`. Update `category-field.tsx:20` and `task-dependencies.tsx:53`. `useTaskCategories` (`:16-23`) has the same loading→`[]` collapse; fix it in the same step.
- Delete the exports at web `index.ts:6-10` and server `index.ts:10`.
- Lint: remove `resource.ts`, `shared/resources.ts` and `web/hooks.ts` from Item 3 (`network/live/lint/index.ts:35-~82`).
- **C39 old-bundle check** (open since 16b.3, see *As landed → 16b.3*): the old `task-categories` is param-less, so an old tab subscribes `{}` and passes the new gate. Run the 16b.6 old-descriptor `{}` subscription harness against the real `task-categories` `all` entry, and test that the new compiled rows parse under the old `TaskCategoryRowSchema` to equal values (byte-compatible), or rename the key.

### 19: `tasks`
- `attempt_conv_agg.has_waiting_conv = bool_or(status='waiting')`.
- New `tasks-core/server/internal/derived.ts` holds `attemptDerived`, `taskDerived` and `depIsBlocking` (moved from `views.ts:189-200`). `directDepIsBlocking` (`:204-209`) stays for `queries/tasks.ts`. Rebuild `attempts_v`, `task_blocking_v` and `tasks_v` on these builders, so `tasks_v` no longer reads `pushes` or `conversations`. `views.test.ts` must stay green. Re-check `view_table_usage` after the rebuild.
- Joins:
  - `children(att)` with both rollups;
  - `children(deps)` → `dependencies` via `array_agg(depends_on ORDER BY created_at)`, `ifNone ARRAY[]::text[]`;
  - `closure(blocking)`;
  - `finishedAt` = min over the task's attempts of `min_push_at`; soundness is verified.
- `task_dependencies` moves to a routed trigger with `column:"task_id"`.
- C24: `taskDescriptions` replaces `taskDetail`. `task-description.tsx:74-99` reads `useTask` plus `useLiveRow(taskDescriptions, id)`. The getTask refetch (`:43-51`) stays and reads `tasks_v`.
- **Readers** (`useResource(tasksResource)`, 20 production sites; recount when implementing):
  - `client.ts:52,87`; task-graph hooks `:25`; `task-draft-popover:339`; task-detail panes `:37`;
  - `deps-tree-section:34,47`; `child-count-action:17`; `tasks-list-view:30`; `task-dependencies:52,111`;
  - `use-worktree-identity:68`; `use-queue-rows:84`; `dependencies-button:41`; `task-link-chip:19`;
  - `attempt-chip:49`; `task-card:241`; page task-link hooks `:59`; `add-task-tool-view:58`.
- Delete the barrel export at `tasks-core/server/index.ts:80`. Lint: remove the 13 `· tasks` files.
- **C39 old-bundle check** (open since 16b.3, see *As landed → 16b.3*): the old `tasks` (`queryResourceDescriptor("tasks", TaskListItemSchema, "id", { preload: "boot" })`) is param-less, so an old tab subscribes `{}`, passes the new gate and parses the compiled rows with the old `TaskListItemSchema`. Test that subscription against the new `all` entry with the 16b.6 old-descriptor `{}` subscription harness; keep the wire row identical to `TaskListItem` (D19 already keeps `dependencies` and `minPushAt`), or rename the key, or add a contract signal on `{}`.

### 20: `attempts`
- `all.orderBy createdAt asc` (matches `resources.ts:229-232`).
- `children(convs, kind<>'system')` → `jsonAgg(id,title,status,kind,createdAt,spawnedBy; createdAt asc)`.
- Conversations route gate `{attempt_id, id, kind, title, status, created_at, spawned_by}`. It excludes `waiting_for`, `last_viewed_at` and `updated_at`, and replaces the signature gate. **This fixes C1.**
- Delete: `pushesAttemptsCascade` and its declare (`server/index.ts:243`/`:246`), `listPushes` (`server/index.ts:127`), `listConversationSummariesByAttempt`, the carrier, and the export `:81`.
- Readers:
  - `attempt-pane.tsx:163,185`;
  - `attempt-switch-button.tsx:16`;
  - attempt-view `panes.tsx:17`;
  - `tasks-core/web/hooks.ts:39,77`;
  - `use-worktree-identity.ts:48` (select+gate);
  - `attempt-chip.tsx:48`.
  - Comments to update: `conversation-item.tsx:52`, `conversation-row.tsx:40`, `conversation-chip.tsx:13`.
- Doc sweep:
  - `docs/tasks-model.md:119-136`;
  - `tasks-core/web/internal/register.ts:1-19`;
  - `tasks-core/CLAUDE.md:204-207` (autogen `:223`, `:390`);
  - the pushRows comment `core/resources.ts:~67-69`;
  - the `queries/pushes.ts` doc.

### 21: `agent-launches` (atomic with the rollup source)
- `task_latest_conversation` gains an `attempts` source: `AFTER DELETE` and `AFTER UPDATE` with no column list (C1). Task ids come from `old_rows.task_id`. It also heals a task delete.
- `rollup(latest, on base.taskId)` ⇒ reverse routes `attempts.task_id → launches` and `conversations → attempts.task_id → launches`. `agent_launches` gets a routed layout. Seq scan on 29 rows; no index.
- C27 wire. `handle-list-launches.ts:27-28` keeps its hand-written form; note it as a duplicate.
- C28 deletions, plus `agents/web/index.ts:27` and `server/index.ts:42`. Regenerate the tasks-core and agents autogen.
- Lint: agents `shared/resources.ts`, the five components, `server/internal/resources.ts`.

### 22: conversations
- **active / system:**
  - `all` over `_conversations` + `conversationOwnerJoins` (needs C5);
  - `active`: `where status<>'done' AND kind<>'system'`, `orderBy createdAt desc`; `active` as an ExprField;
  - `system`: `kind='system' AND status<>'done'`;
  - `waitingFor` is a one-row identity refill;
  - `debounceMs` dropped (D16; fallback `throttleMs` via C18).
- **gone:**
  - a window with default `{orderBy [['endedAt','desc']], limit 30}`, `maxLimit ≥ 50`;
  - base `status='done' AND ended_at IS NOT NULL AND kind<>'system'`;
  - preload boot; leaves L2.
- **by-id:**
  - lookup-only, full `ConversationSchema` (`conversations.all:rows` lacks `waitingFor`, `lastViewedAt` and `claudeSessionId`, so it cannot serve);
  - owned by `tasks-core/core`.
- **Readers:**
  - **(K) `useConversation(id)`** (`use-conversations.ts:71-95`, 5 production callers): the three-list slice becomes `useLiveRow(conversationsById, id)`, mapped to `ConversationEntry | null`. Delete `resolveConversation`. This is what fixes W9.
  - `useResolveConversation` and `useConversationById` → by-id; delete their REST fallbacks and the "held" state;
  - if nothing else calls `GET /api/conversations/:id`, delete it too (`conversations/core/endpoints.ts:73`, `handle-get.ts`, `CLAUDE.md:161`);
  - list, title and sibling hooks → `useLive(active|system|gone[, {select}])`;
  - `use-queue-rows.ts:82-83`; `recovery-view` per C25; `welcome-view.tsx:27` adapts to the window shape.
- `conversationsGoneStats` (`queries/conversations.ts:195-201`) is re-pointed at `_conversations`.
- Delete the exports `tasks-core/server/index.ts:82-84` and the declares `:247-249`.
- Lint: remove the last Item 3 tree files.

### 23: S6 deletions
**Precondition (C32):**
- `rg 'keyedResourceDescriptor\(|queryResourceDescriptor\(|queryResource\('` returns only the definitions.
- The C32 measurement is done.

**runtime.ts:**
- ScopePolicy keeps the two routed arms (`:519-575`).
- Delete:
  - `ServerResourceOptions` `:706-723`;
  - the `contractToDefinition` `identityTable` (`:788`);
  - `routingRecordFor` `:2797`, `:2815-2819`;
  - the buildEntry guard `:3015`;
  - `derivedIdentityTable` `:2884-2891`, `:3176-3178`;
  - bind `:3297-3298`;
  - `scopedResourceTables` else-branch `:6726-6731`;
  - `_debug` `:6182-6189`;
  - `coveredOriginsFor` `:2024-2050`;
  - the drain cascades `:4217-4225`, `:4466-4488`, `:4579` (owner-mismatch becomes a bare `return`);
  - the `Resource.notify` `affectedIds` option (`:840`, `:2955-2958`; `LoaderCtx.affectedIds` stays).
- Add a buildEntry throw for `identityTable`, `recompute` or `fanOut` reached through a cast.
- Before the A25 policy throw (non-null `affected` on a non-membership entry), confirm that `routeTableChange` never schedules one for a `reach` entry. This is uncertain; cover it in the scoped-routing suite.

**applyDbChange → `applyLegacyFullChange({table, source, xid?, changedAt?})`:**
- `applyDbChange` is at `:6554-6624`. Its only caller is `route-change.ts:106,117`; every other path goes through `routeChange`.

**Relation bases (C30):**
- Delete `resolveRelation` and `feedExemptTables` from the runtime opts (`:1446-1467`), plus their wiring (`server-core/core/resources.ts:338-346`) and holders (`:140-169`).
- Add `setRelationBases(fn)` and the version closures.
- change-feed:
  - `relationBases(r)` = `{r}` ∪ the transitive bases through `view_table_usage`, with rollups replaced by `rollupSources()`; memoized, cycle-guarded;
  - set it in onReady **before** `startListener` and catch-up (`server/index.ts:138-145`); remove the `relationIdentityBase` import at `:15`;
  - `feedExemptTables()` itself stays (`:98`, route-coverage).
- Delete the `dependentViews` loop.

**Other plugins:**
- derived-views: delete `relation-identity.ts`, `View.identityTable` and the uses at `tasks-core/server/index.ts:250,251,256`.
- query-resource: delete `rel.ts`, `compile.ts`, the Edge/Hop/QueryResourceSpec parts of `spec.ts` (`:149`, `:178`, `:260-263`) and their tests. Reword `compile-window.ts:32,57,310,516`, the `identity.ts` prefixes and the barrel description `index.ts:39`.
- live-state: delete `keyedResourceDescriptor` (`primitives/live-state/core/resource.ts:201`); query-resource: delete `queryResourceDescriptor` (`core/internal/descriptor.ts:66`), its core barrel export and its contract types. **(K)** The client descriptors are replaced in their own steps, not here:
  - step 18: `task-category/shared/resources.ts:24`;
  - step 19: `tasks-core/core/resources.ts:41`;
  - step 20: `:56`;
  - step 21: `agents/shared/resources.ts:41`;
  - step 22: `:100+`;
  - plus `core/index.ts:47-51` in each step.

  The fixtures `parse-resources.test.ts:196` and `eager-tier-gen.test.ts:276` move with them.
- vocabulary: delete `:216-225`, the marker at `:281`, `QUERY_RESOURCE_CORE` `:53`, the type import `:7`, the arm `:190` and the comments `:260,298-299` (forced together by `RegisterMarkersAreLive`).
- T15 (C29).
- keyed-resource-scope check: keep rules 1–2. Rule 3 becomes a token ban on `identityTable` and `fanOut:` under `plugins/` (non-test). Rewrite the description at `:29` and the hint at `:272`.
- A6: expand `tables_read` through `relationBases` in `createProducedPersistGuard` and `sweepProducedSnapshots` (D28).

**Tests:**
- 15 resource-runtime suites: runtime, -ack-channel, -cascade-attribution, -catchup, -changed-at, -h5, -profiling-hooks, -scoped-membership, -scoped-routing, -stale-flight, -table-routing, -tracking-span, -version-shortcircuit, -watermark, -window-membership. Add a shared minted-routed fixture in `resource-runtime/core/testing`.
- change-feed: route-change, route-coverage.
- Others: produced-guard, eager-tier-gen (`:196`), query-resource compile/compile-runtime (delete), runtime-profiler install, network/live (legacy-descriptors, compile-window-runtime, compile-window, serve-collection, serve-value), page-doc-order, parse-resources (`:120`, `:271`), no-pending-data-collapse (`:102`, `:344-361`).
- Keep green: `reports-list-oracle.test.ts:49,296`.

**Docs:**
- The plugin CLAUDE.md files listed in v2, plus:
  - `install-feed.ts:59`, `exclusion.ts:35`, `route-coverage.ts:8-9,48,152`, `view-deps.ts:6-18`;
  - `server-core/core/resources.ts:416-431,518`;
  - `catch-up.ts:50-58`, `produced-guard.ts:18-20`;
  - `legacy-descriptors.ts:21-22`;
  - the `get_runtime_profile` docs (`mcp-tools.ts:64`; `cascade` changes meaning).

### ★24: A7 and A26
- `_debug` per entry:
  - `policy: routed | external | legacy-full`;
  - `persisted`, `definition`, `derivedReads`, `tuples`, `positionAgeMs` (a new sync hook `persistedMeta(key)` backed by an in-memory map in live-state-snapshot);
  - `readSetBases` via `relationBases`, unfiltered.
  - Drop `identityTable`, `recompute` and `coveredOrigins`. live-state-health (`shared/endpoints.ts:21-37`) strips unknown fields, so this is safe.
- `computeCeiling` → `read-set/web/internal/ceiling.ts`:
  - `legacyFull`: entry plus transitive bases, tuples, persisted;
  - `routedFull`: every route with `map==='full'`, plus its reason;
  - `drift`.
  - Delete the recompute arm (`read-set-view.tsx:127-129`) and Section C (`DiffSection` `:506+`).
  - `shared/schema.ts:77-84` changes in the same commit.
- A26:
  - a runtime test that every registry key appears with a policy (decide the deferred-before-bind policy);
  - bun `ceiling.test.ts`.
- **Final review stop.**

## 7. Verification
- v2's oracle and e2e lists, plus:
  - the union snapshot;
  - lookup-in-`all` parity;
  - the define-rollup oracle (C1 cases);
  - the boot-layer deadlock oracle;
  - the 16a hot-swap, backstop and bounded-leak cases.
- `get_runtime_profile` per e2e, one kind at a time (`kind='all'` is about 281 KB):
  - no FULL outside boot, compaction, over-cap and declared legacy-full;
  - persist spans ≤ 1 per key per 2 s;
  - closure spans within D12;
  - no `runs:groups`;
  - zero loads for `pid`, `rank` (except one `orderOf`), `lastViewedAt` and `waitingFor` (except the one-row active refill).
- **(K) One check per defect** (`get_runtime_profile` loader spans over `tree-live-verify`):
  - W1: a task or attempt status flip ⇒ a scoped load (`ids` ≤ changed + dependents), never FULL.
  - W2: an INSERT or DELETE on the identity origin ⇒ entrant or exit, not FULL.
  - W3: a push ⇒ 0 FULL on `attempts` and `tasks`; `pushes.attempts-cascade` no longer exists.
  - W4: a task write and an attempt write ⇒ 0 loader spans on `conversations-active`, `-system` and `-gone`.
  - W5: the C37 oracle.
  - W6: the final `rg` audit.
  - W7: the ★24 pane lists `agents`, `pages` and the other legacy-full entries with their transitive bases.
  - W8: the define-rollup oracle's attempt-delete cases.
  - W9: open a done conversation older than the newest 30; it resolves with no REST call.
- Trigger time: re-run the §4.3 script after 16b.2 and after each of 18–22.
- Final audit: `rg` finds no `rel(`, `identityTable`, `compileEdges`, `fanOut:`, `keyedResourceDescriptor`, `queryResourceDescriptor` or `coveredOrigins` outside docs.

## 8. Risks (ranked)
1. **The 16a L2 rewrite.** A wrong position or definition means a stale first paint. Mitigations: the predicate, baseFloor, the backstop-first onReady, the C22 self-invalidation, and the oracles.
2. **The `routedReads` generalization (16b.4)** sits on the hot path of every serveCollection and the union. A route-id or column-order change rebuilds triggers on hot tables. Mitigation: the union snapshot plus the golden, both byte-identical.
3. **Boot trigger DDL on conversations, attempts and pushes (16b.2, 21)** can deadlock with an old backend during a hot swap. Mitigation: per-table savepoints in a fixed order; a loud failure otherwise.
4. **Silent staleness from an unregistered CTE read** (no route columns). Mitigation: the bind assert in C7.
5. **Catch-up replay volume** once tasks and attempts are floor-persisted (floor ≤ about 1 h). Measured at ★17.
6. **The cross-rollup advisory-lock order** across RI-cascade statements cannot be globally sorted, so an abort stays possible. It must be loud.
7. **The derived gate latch** changes first-render behaviour for every select+gate caller app-wide.
8. **The `tasks_v`/`attempts_v` text change at 19** alters `view_table_usage` and therefore forwarding until step 23. Re-check after the rebuild.
9. **Step-23 test churn** (about 25 suites). Budget a dedicated pass with the shared fixture.
10. **The pane cannot be trusted until 24.** For 17–22, verify with loader spans instead.

## Known limits added by v3 (K)
- `agents` (`agentRows`, `agents/shared/resources.ts:33`) stays a persisted legacy-FULL entry. It is outside this task's list. The compact job and the backstop bound its staleness, but a change still reloads it in FULL.
- Still unmeasured until ★17:
  - the `persistSnapshot` db-span cost;
  - the trigger-time baseline;
  - D23;
  - whether the rollup `n_tup_upd` totals are a per-boot rewrite (measure the delta across one restart).

## 9. New defaults D24–D30 (each has a recommendation; override at approval)

| # | Question | Recommended default |
|---|---|---|
| D24 | A rollup, children or closure join in a `:groups` spec: build the source-route expansion, or refuse at module eval? | **Refuse** (rung 4, plus the tsc split via `AllJoinSpec`). No P8 surface needs it. |
| D25 | Boot rollup trigger DDL: per-table savepoints (more code), or accept a loud boot abort on a 40P01 during a hot swap? | **Per-table savepoints**, mirroring change-feed. |
| D26 | Step 19: fold `taskDetail` into the new `taskDescriptions` and delete it (v2 did not mention it)? | **Yes, replace and delete.** |
| D27 | Step 22: delete `GET /api/conversations/:id` once by-id removes its last two callers? | **Delete it** in step 22, if `rg` shows no other caller. |
| D28 | A6 gap after step 23: a persisted legacy reader of a view over a produced table is not refused. Expand `tables_read` through `relationBases`, or record it as a Known limit? | **Expand it** in step 23; it is a small change in produced-guard. |
| D29 | The live-state gate-latch change affects every select+gate caller (fewer renders). Ship it app-wide in 16b.7, or scope it to `useLive(all)`? | **App-wide.** It is a correctness improvement; the jsdom test pins it. |
| D30 | `handle-list-launches.ts` duplicates the latest-conversation logic. Re-point it at the compiled alias in step 21, or leave it? | **Leave it**; file a follow-up task. |
## As landed

### 16·0 — trigger-time baseline (§4.3) and the union snapshot (C6)

**Trigger-time baseline.** Script: `plugins/tasks/plugins/tasks-core/e2e/trigger-time.ts` (an `e2e/` script, so `targetNamespace()` resolves this checkout's deploy and the script refuses main). Each DML runs as `EXPLAIN (ANALYZE, FORMAT JSON)` inside `BEGIN … ROLLBACK`, and the per-trigger times are read from the plan's `Triggers` array.

- **Run:** namespace `att-1791291155-csw8` (a fork of main), 2026-10-06, Postgres 18.3, **median of 9**.
- **Row counts:** tasks 5027, attempts 4681, conversations 4881, pushes 4106, task_dependencies 1817, tasks_ext_category 3004.
- **Why 9 repeats, not 3:** with the same pinned rows, two 3-repeat runs differed by up to about 45% (cascade delete 1.211 ms against 1.765 ms; conversation status update 0.675 ms against 1.130 ms). The first run of each case is always cold, at 3 to 12× the median.
- **Fixture:** every later run must pin these rows. If it cannot, it says so beside its numbers.
  - attempt `att-1790171990-gvf7`, on task `task-1789917523347-7c5wn9`;
  - conversation `conv-1790171990-gsrc`;
  - other task `task-1791291104773-ac57q3`;
  - dependency `task-1791290989353-f13l6v → task-1791031230318-lwd9lz`;
  - category task `task-1791291104773-ac57q3`.
- **`DELETE attempt` fan-out** (counted before any DML): 1 conversation, which carries 2 conversation_categories rows, 1 conversations_ext_progress row and 1 conversations_ext_queue row; and 1 push.
- **Re-run command:**

  ```
  ./equin run plugins/tasks/plugins/tasks-core/e2e/trigger-time.ts --repeats 9 \
    --attempt att-1790171990-gvf7 --conversation conv-1790171990-gsrc \
    --other-task task-1791291104773-ac57q3 \
    --dependency-task task-1791290989353-f13l6v --dependency-on task-1791031230318-lwd9lz \
    --category-task task-1791291104773-ac57q3
  ```

  `--pin <run.json>` takes the whole fixture from an earlier `--json` record instead.

| DML | exec ms | in triggers ms | largest triggers (median ms) |
|---|---|---|---|
| UPDATE tasks status (`held_at`) | 0.378 | 0.314 | `live_state_tasks_u` 0.304, `tasks_derive_updated_at` 0.015 |
| INSERT attempt | 0.269 | 0.223 | `live_state_attempts_i` 0.179, FK 0.044 |
| UPDATE conversations status | 1.048 | 0.988 | `live_state_conversations_u` 0.416, `task_latest_conversation_u` 0.383, `attempt_conv_agg_u` 0.179, derive_updated_at 0.010 |
| UPDATE conversations `waiting_for` only | 0.788 | 0.753 | `task_latest_conversation_u` 0.307, `live_state_conversations_u` 0.302, `attempt_conv_agg_u` 0.133 (both rollups fire on a column neither reads) |
| INSERT pushes | 0.312 | 0.277 | `live_state_pushes_i` 0.117, `attempt_push_agg_i` 0.116, FK 0.023 |
| INSERT task_dependencies | 0.119 | 0.095 | `live_state_task_dependencies_i` 0.053, FKs 0.025 + 0.016 |
| DELETE task_dependencies | 0.041 | 0.033 | `live_state_task_dependencies_d` 0.033 |
| UPDATE tasks_ext_category | 0.057 | 0.042 | `live_state_tasks_ext_category_u` 0.040 |
| DELETE attempt (cascade) | 0.925 | 0.907 | `task_latest_conversation_d` 0.201, `attempt_conv_agg_d` 0.081, `live_state_attempts_d` 0.071, `live_state_conversations_d` 0.063, `attempt_push_agg_d` 0.062, `live_state_pushes_d` 0.057, then about 20 ext-table `live_state_*_d` and FK triggers at 0.008–0.053 each |
| UPDATE attempts.task_id | 0.153 | 0.137 | `live_state_attempts_u` 0.129, FK 0.005, derive_updated_at 0.003 (no rollup source on attempts yet; it comes in step 21) |

- **COMMIT round trip** (`pg_notify` lands at commit): 0.227 ms with one throwaway row on each of tasks, attempts, conversations, pushes, task_dependencies and tasks_ext_category. An empty transaction's COMMIT takes 0.036 ms (median of 9 each).
- **Earlier unpinned run:** the first 16·0 run measured 1.677 ms for the cascade delete and 0.462 / 0.067 ms for the two COMMITs (median of 3). It recorded no fixture, so it is superseded by this table and is not comparable to it.

**Union SQL + routes snapshot (C6).**

- **Files:** the fixture is `network/live/server/testing/compile-union-golden.json`, the test is `server/internal/compile-union-golden.test.ts`, and the generator is `./equin run plugins/network/plugins/live/server/testing/gen-compile-union-golden.ts`.
- **Provenance:** generated from the pre-16b code.
- **Coverage:**
  - four arms: a text pk; a text pk with a LEFT lookup; an integer pk; a uuid pk with a REQUIRED lookup, which renders INNER JOIN;
  - `pg_input_is_valid` for both the integer and the uuid pk;
  - a `timestamptz`-spelled read checked against the column's `timestamp with time zone`;
  - each identity route's arm-key `encode`, called on `["7", "a1", "x:y"]`.

### 16b.1 — `raw-sql.ts`, `quotedRelationsIn`, the `aggregate` read expression

- **`query-resource/server/internal/raw-sql.ts`** holds `canonicalSqlType` (with `TYPE_ALIASES`), `nullOf`, `decoderOfRead`, `allOf`, `fromSql(base, plan, included, label)` and `anyOf(col, ids, { invalid })`. The union and the join routes' reverse probes import them; nothing private is left in `compile-union-window.ts`.
- **Invalid-id policy (C6):** `anyOf` requires `{ invalid: "throws" | "absent" }` (tsc). `"throws"` renders the old `joins.ts` form (`col = ANY($1::<type>[])`); `reverseMap` passes it for `changed`, a change's own keys, which the database vouched for. `"absent"` renders the old union `idsIn` form (`pg_input_is_valid` for a non-text pk) and is what the union's scoped refill and `:rows` pass, so a bad key stays absent.
- **Open gap — `within` (scheduled as step 16b.1a, §5/§6; not yet landed):** `reverseMap` also passes `"throws"` for `within`, unchanged from before 16b.1, and that is the wrong choice: `within` is NOT always vouched for. For a point reader it is the client's own `:rows` id set (`resource-runtime`'s `reverseWithin` returns `membership.idsOf(params)`; the union's is `spec.point.idsOf`, and `compiledUnionRoutePlan`'s reverse wrapper decodes it straight to raw arm ids). A client subscribing the union `:rows` with `uuidarm:x` on a uuid-pk arm with a lookup gets the key treated as absent by the `:rows` load (C6), but every change to the looked-up table then runs `"pk" = ANY($n::uuid[])`, which raises `invalid input syntax for type uuid`; `resolveReverseRoutes` reports a loader error and recomputes the readers FULL — and since bounded readers' `within` sets are unioned, one bad key poisons the probe for every bounded `:rows` reader of the entry, with a report on every lookup write. The fix: `within` only bounds the answer, and a key the pk type cannot hold bounds to no host, so pass `{ invalid: "absent" }` for `within` (always, or by origin). It changes the uuid arm's reverse-probe SQL in the union snapshot (and any non-text-pk reverse probe in the compile golden), so it lands as its own deliberate step with regenerated, reviewed fixtures — not inside 16b.1's byte-identical refactor.
- **`quotedRelationsIn(text)`** is exported from `database/server`. It is the quoted branch of `extractReadTablesFromSql`; both now read one scanner (`readClauseNames`), so capture output is unchanged.
- **`aggregate` (C7 groundwork):** `readExpressions` gains `{kind:"aggregate", name, relation, reads, nullable, sqlType}`, registered through `JoinPlan.renderAggregate(sql, {…, decoder})`. `columnsIn` descends into `reads` in place of the SQL. `columnOf`/`relationOf` throw, `memberOf` is undefined, and `relationKey` is `aggregate:<name>`. `canBeNull` is `nullable || outer(relation)`, the rule a column read follows. `JoinPlan.isExpr` is renamed `isComputed` ("reads no one column": an expression or an aggregate), so `arm-plan`'s select-all signature guard and `serveCollection`'s computed-read nullability backstop take an aggregate down the expression path. Registration refuses reads that resolve to no relation column (risk 4), an undeclared `relation`, and a bad `sqlType`. Closure-internal relations, rollup routes from `src.reads` and the projection-wide bind assert come later (16b.4/16b.5).
- **Byte-identical:** `compile-sql-golden.test.ts` and `compile-union-golden.test.ts` pass unchanged; neither fixture was regenerated.

### 16b.2 — `defineRollup`, the boot install, the three conversions

- **API (`derived-tables/core`):** `defineRollup({ table, key, select, sources: [{ table, carry, via?, reads, ops? }] })` → a branded `Rollup` (only `defineRollup` mints one). `select(scope)` is the one query computing the rows (`scope(keyExpr)` renders `true` in the reconcile and `keyExpr = ANY(<keys>)` in a maintain); `DerivedRollupSpec` and its opaque DDL strings are deleted. Asserted at eval: the table is an IMPERATIVE_PUBLIC_TABLES value (C11, `assertImperativePublicTable` in derived-views/core), `key` is its only pk column, every column belongs to its table, a carry (or via hop) has the key's type, one source per table, `scope` called once, generated names ≤ 63 bytes.
- **Generated per source** (A21): `<rollup>__<src>_maintain()` and `<rollup>__<src>_{i,u,d}` (`CREATE OR REPLACE TRIGGER`, `AFTER UPDATE` with no column list — C1). The maintain collects carried values (UPDATE: `old_rows FULL JOIN new_rows ON pk WHERE pk unmatched OR ROW(carry, reads) IS DISTINCT`), resolves keys (through `via`), sorted, takes `pg_advisory_xact_lock(hashtextextended('<rollup>:' || key, 0))` per key in that order (A34), then aggregates in a fresh statement, upserts `DO UPDATE … WHERE ROW(t.vals) IS DISTINCT FROM ROW(EXCLUDED.vals)` and deletes keys the aggregate lost.
- **Reconcile (D21, A34):** per rollup, in one transaction (a schema-layer savepoint): a read-only drift scan returns the differing / missing / stale keys (a clean boot stops there: no write, no lock); the maintain functions' advisory lock on each, in the same sorted order; then the maintain's own write over those keys in a fresh statement (re-aggregate, upsert only what differs, delete what has no aggregate). Returns `{upserted, deleted}`. (Review fix: the first cut was one CAS-guarded statement, which could still overwrite a row with a pre-commit aggregate when a concurrent maintain found the drifted row already equal and wrote nothing.)
- **Boot install (`rebuildDerivedTables`, C12/C13/D25):** table by its live shape (create, or DROP CASCADE + recreate on mismatch — the old trailing `ALTER … ADD COLUMN` is gone); functions signature-gated per rollup; triggers one source table per savepoint, sorted by name (attempts < conversations < pushes), only when that table's signature or catalog set differs; stale managed triggers (legacy `<rollup>_{i,u,d}`) dropped, then unused managed functions; an A21 catalog assert every boot (exact set, function, AFTER/STATEMENT, one op, no column list); reconcile after all savepoints. Per-object signatures live in a new imperative table, `derived_table_object_state` (`functions:<rollup>`, `triggers:<table>`); the older builds' one-row `derived_table_state` keeps its shape and is only emptied every boot, so a revert of main (or a branch on a fork of main) finds no signature and reinstalls its own triggers rather than failing its `ON CONFLICT (id)` insert or trusting a stale row. Trigger skip-when-unchanged compares each trigger's shape (AFTER, STATEMENT, op, no column list), not only its name and function, so a hand-altered trigger is reinstalled rather than refused by A21. Whenever a rollup's functions are (re)installed, its `select` is compiled as a temp view and asserted: output columns exactly the table's; every column it reads (from `pg_depend`) declared as a source's pk / carry / reads or a via's match / key; no other table. Returns `{table, upserted, deleted, definitionChanged}[]`, threaded out as `applySchemaLayer` → `{pending, rollups}` (`SchemaLayerResult`); the database plugin calls `publishReconciledRollups` after commit; `reconciledRollups()` throws before it.
- **A20:** live-state-snapshot asserts `reconciledRollups()` in `onReadyBlocking` and, when any rollup was healed, clears every persisted row there (`clearHealedSnapshots`, before readiness flips — boot-snapshot never serves a value computed from the drifted rollup); `runBootCatchUp` takes `healedRollups` and treats a non-empty one as the backstop (clear again + recompute every persisted key), since a heal has no changelog rows.
- **`rollupSources()`** (C30): every rollup → its trigger source tables, from the `DerivedTable` collection.
- **Conversions:** `attempt_push_agg` (pushes; reads `created_at`), `attempt_conv_agg` (conversations; reads `status`, `ended_at`), `task_latest_conversation` (conversations via attempts; reads `kind`, `title`, `status`, `created_at`). The attempts source stays step 21; the W8 gap is stated in `agents/server/internal/rollup-spec.ts`.
- **On the fork of main** (`att-1791291155-csw8`, 2026-10-07): before the build all three rollups equalled their aggregates (0 differing rows). The first boot dropped the nine legacy triggers and three `*_maintain` functions, installed 9 generated triggers on conversations and pushes, and reconciled with **no drift** (0 upserted, 0 deleted) on all three; a second boot took no definition step and again healed nothing. After deploy the rollups still equal their aggregates. L2 boot: no heal backstop (normal replay).
- **Trigger time after 16b.2** (same pinned fixture, median of 9; absolute numbers ran lower across the board on this run, so compare the rollup triggers): `UPDATE conversations waiting_for only` — `task_latest_conversation` 0.307 → 0.011 ms, `attempt_conv_agg` 0.133 → 0.013 ms (the diff returns before aggregating); `UPDATE conversations status` 0.383 / 0.179 → 0.160 / 0.103 ms; `INSERT pushes` `attempt_push_agg` 0.116 → 0.096 ms; `DELETE attempt` cascade `task_latest_conversation__conversations_d` 0.201 → 0.020 ms (the hop finds no attempt — W8, step 21). Exec: waiting_for-only 0.788 → 0.202 ms, status 1.048 → 0.464 ms, cascade delete 0.925 → 0.752 ms. COMMIT with throwaway rows 0.088 ms vs 0.042 ms empty.
- **Tests:** `derived-tables/core/internal/define-rollup.test.ts` (generated shape, eval refusals); DB oracles in `migrations/check/internal/` — `rollup-oracle.test.ts` (the step-21-shaped rollup: inserts, system rows, non-read and non-moving updates keep xmin, attempt `task_id` move, attempt delete falling back, last-attempt and task deletes, reparent, multi-row; clean reconcile writes 0; drift healed with exact counts; A34 two-writer test, which fails with the lock loop removed; a heal racing a same-key writer waits for its lock and writes nothing stale; A21 reinstates a dropped trigger, repairs one altered to `UPDATE OF status`, drops a stray one and replaces a legacy trigger + function; the select assert refuses an undeclared read column, an undeclared table and an extra output column; the legacy state table is emptied with its shape kept) and `rollup-boot-order.test.ts` (C12: a same-order writer only delays the layer; unchanged triggers take no source lock under `lock_timeout = 500ms`; a reverse-order writer fails the layer loudly naming `pushes` with 40P01); `schema-layer-replay.test.ts` (second apply `{pending: 0, rollups: all 0/0/false}`); `rollup-spec.test.ts`, `views.test.ts`, `auto-start-launch.test.ts` through `installRollups`.
- **Placement:** the DB oracles live in `migrations/check/internal/`, not derived-tables: derived-tables is upstream of `database` (via migrations), so a derived-tables suite importing `db-test-fixture` (→ admin → database) closes a plugin-boundary cycle — the same reason the schema-layer suites sit there.

### 16b.3 — the `all` spec, its descriptor and contract, the `all`-only join kinds, `mintsOf`

- **Spec (C16, T13):** `liveCollection(key, { row, id, all: { orderBy, unbounded: { reason } }, preload? })`. The `all` branch runs first in the implementation. `all?: never` is on `LiveCollectionSpec` (so on `LiveArmsSpec`) and on the lookup spec; beside `all`, every window and union field is `never`. Runtime throws: `default`, `arms`, `filterable`, `sortable`, `maxLimit`, `scroll`, `contributed` or `columnScope` beside `all`; an empty (or missing) reason; an empty `orderBy`; an order field that is not a row field, named twice, or a direction other than asc/desc. `preload: "none"` is the absence of the flag.
- **One no-window overload, not two.** The lookup-only and `all` forms share one overload, `<Row, const Al extends LiveAllOrder<Row> | undefined = undefined>(key, spec: LiveNoWindowSpec<Row, Al>): LiveNoWindowCollection<Row, Al>`, with `LiveLookupSpec` / `LiveAllSpec` and `LiveLookupCollection` / `LiveAllCollection` as aliases. Two reasons, both measured on tsc:
  - past three failed candidates TypeScript reports only the LAST overload's errors, which moved every existing misdeclared-spec `@ts-expect-error` (query-codec, live-arms) off the field at fault;
  - the resource vocabulary infers the last overload's return type, and a return type conditional on `Al` at its top level made `liveCollection` stop matching `(...args: never[]) => infer R` — so the `all`-vs-lookup difference lives in one property, `all: [Al] extends [undefined] ? undefined : AllQueryResourceContract<Row>` (a lookup collection now carries `all: undefined`).
- **Descriptor (C39):** `allResourceDescriptor` (internal to `network/live/core`, beside the window and point factories) mints `AllQueryResourceContract<Row>` (`query-resource/core`): keyed, schema `z.array(row)`, no `initialData`, no `defaultParams` (boot hydrates `{}`), `all: { orderBy, unbounded }`, `queryPk`; any param throws `ResourceContractError` (an old-bundle tuple that SENT params is `contract-mismatch`, a `skew` verdict). It self-registers under `key` (`resourceDescriptorByKey(key)` resolves it — tested). The full boot-snapshot hydration and `useLive(all)` render-without-round-trip tests need the server half and the hook: they are carried on the 16b.6 and 16b.7 rows of §5.
  - **C39 open item — the params gate does NOT cover the real old-bundle case.** The keys converted to `all` (`task-categories` at 18, `tasks` at 19) are today `queryResourceDescriptor`s with no params, so an old tab subscribes them with `{}`, which the new gate accepts (tested: `validateParams({})` passes). Nothing answers `contract-mismatch`; the old client parses the new compiled rows with its OLD row schema. A params gate cannot see this skew. Each converting step must close it with a real test — an old-descriptor subscription with `{}` against the new `all` entry, asserting the verdict (or the parse) it gets — and one of:
    - **byte-compatible rows** (the expected case for 18: the row stays `TaskCategoryRowSchema`): a test that parses the new compiled rows with the OLD schema object and gets equal values — never a `{}` that happens to pass;
    - **a renamed key** when the row changes: the old tab's key is then `unknown-key`, whose verdict is already `skew` (`unknownKeyVerdict`);
    - **a contract signal on `{}`** (a row-schema fingerprint in the descriptor or the build-graph contract that the runtime compares) — protocol work, only if neither of the above fits.
  - 16b.6 (the server half) is where the `{}` subscription first reaches an `all` loader; its §5 row carries this check for the synthetic collection (the old-descriptor `{}` subscription harness), and the step 18 and 19 work lists run that harness against their real keys.
- **Serve guard:** `serveCollection` throws on a collection carrying `all` (its lookup arm would otherwise serve it as lookup-only); the tsc twin is `all: undefined` on `LiveLookupCollection` and `all?: never` on `LiveCollection`. 16b.6 replaces the throw with the `all` branch.
- **Join kinds (`query-resource/core/internal/all-joins.ts`):** `RollupJoin` (`on` a `ColumnRef`, carrying the `Rollup` itself — a type-only import of `derived-tables/core`, so routes come from `rollup.sources` and the table read is `rollup.handle`: `defineRollup` now returns `Rollup<T>` carrying its drizzle handle, and a rollup join declares no `table` of its own, so it cannot pair one rollup's sources with another's table), `NestedRollupJoin` (`on` a host column, under children or a closure ancestor), `childrenJoin({ alias, table, fk, rollups?, where?, aggregates })`, `closureJoin({ alias, edges, child, parent, nodes, ancestorJoins?, aggregates })`. `AllJoinSpec = JoinSpec | RollupJoin | ChildrenJoin | ClosureJoin`; `AllJoinRefs` exposes a children / closure join's AGGREGATES only (`AggregateRef`), so a raw child column is a tsc error; `JoinSpec`, `JoinRefs` and every non-`all` compile are unchanged (C9 holds at tsc).
  - Children are keyed by their host's pk (no `on`: the host pk is the only key v2 allows); a closure's ancestor is a row of `nodes` (the base table, asserted at bind in 16b.5).
  - Column ownership is asserted at eval by the builders: a children join's `fk` and its nested rollups' `on` are columns of its `table`; a closure's `child` / `parent` are columns of `edges`, its ancestor rollups' `on` columns of `nodes`.
  - A rollup's columns are typed as `OuterColumnRef`s (a type-only outer phantom on `TypedColumnRef`), top level and nested: the rollup is LEFT-joined, so a `jsonAgg` element field over one is `| null` whatever the rollup table's NOT NULL says.
  - Callback refs are typed with the relation names the compiler will render: `<a>`, `<a>__<r>`, `<a>__anc`, `<a>__anc__<r>`.
  - The callbacks are method signatures (bivariant), and a non-literal alias's refs are `Record<never, never>`, so a join over one table is still an `AllJoinSpec` / `AncestorJoin`.
- **Aggregates (A33):** `aggregate(sql, { decoder, sqlType, notNull?, ifNone? })` — `notNull: true` requires `ifNone` (overload; a runtime throw backstops it); the value is `V | null` otherwise. `jsonAgg(columns, { orderBy })` — never NULL (`[]` for no rows), `sqlType: "json"`, element types the columns' JSON forms (`Date` → `string`, `| null` unless NOT NULL), a non-empty declared order. `ifNone` lives in the `expr` shape; a `json` shape has none to declare (rung 1). Both are branded (`isAggregate`). A39's column-type / `withWire` refusal is bind-time, left to 16b.5.
- **Scanner (C15, A28):** the vocabulary's `liveCollection` entry gains `{ suffix: "", keyed: true, membership: null, preloadable: true, requires: "all" }`. `mintsOf(entry, argsText, where)` (`resource-vocabulary/core/mints.ts`) is the one reading: presence at the spec's own depth (the call's second argument, like `declaresOnDemand`), and a throw naming file and line when two kept mints share a suffix — or when presence cannot be read off the text: a spec that is not one inline object literal (an identifier, a wrapper call `makeSpec({ … })`, `{ … } as const`), a spread at the spec's own depth, or a `requires` field (`default`, `all`) written as a shorthand property. Each would otherwise read as "absent" and silently drop the key from the docs and the eager tier. `parse-resources.ts` and `eager-tier-gen.ts`'s `preloadedKeysIn` both call it (the latter ignored `requires` before, and now reads the mints BEFORE its `preload:` test, so a spec hiding its fields cannot read as "not preloaded"). `resource-vocabulary/core/mints.test.ts` cross-checks `mintsOf` against what `liveCollection` registers at runtime for the window, lookup-only, `all` and union forms.
- **Tests:** `network/live/core/internal/live-collection.test.ts` (mints and registration, the descriptor's shape, the params gate, every runtime refusal, T13 type assertions), `query-resource/core/internal/all-joins.test.ts` (builders, refusals, A33 at runtime and in types, `AllJoinRefs` aggregates-only, `JoinSpec` refusing children / closure), `resource-vocabulary/core/mints.test.ts` (A28), and new cases in `parse-resources.test.ts` and `eager-tier-gen.test.ts` (an `all` collection's keys, depth-0 presence, the both-fields refusal).

### 16b.4 — `joinRoutes` / `routeIdsOf`, rollup routes, the C9 refusal, `derivedReads`

- **Routed half (C8, `query-resource/server/internal/{joins,arm-plan}.ts`):** `joinRoutes(join, host, columnsOf): RawRoute[]` — one route for a window join (the old `joinRoute`, now internal), one per SOURCE for a rollup; `JoinPlan.routeIdsOf(alias)` — `[alias]`, or `<alias>[<source>]` per source; `routedReads` flat-maps `joinRoutes` and its `tuple()` sets every id `routeIdsOf` lists to the join's use. It returns `RoutedReads<P>` = `{ routes, tuple, derivedReads }` (exported type). `CompiledJoin` gains `table` (a window join's `table`, a rollup's `rollup.handle`); every `j.spec.table` reader (`routeColumnsOf`, `fromSql`, `planGroupArm`, `render`, `renderExpr`'s wire check, `columns()`) reads it. A compile with no rollup is unchanged: `compile-sql-golden.json` and `compile-union-golden.json` pass byte-identical, neither regenerated.
- **Rollup join (`compileAllJoins`, the `all` compiler's plan; `PlannedJoin = JoinSpec | RollupJoin`):** LEFT on the rollup's key; `on` the base or an EARLIER join (A4), of the key's SQL type (asserted at compile). Per source: `columns` = pk ∪ carry ∪ reads (sorted — what the maintain diffs); `on` = host pk with no `via` ⇒ `alias` on `carry` (no column when `carry` is the source's single-column pk); otherwise `reverse`: `on = ANY($keys)` from the base and the chain up to `on`'s relation, keys = the values, or with `via` `on IN (SELECT key FROM via WHERE match = ANY($1::<carryType>[]))`; a `via` or chain join over the changed source table itself ⇒ `full`, `pre-image needed: …` (A10). `within` is cast `"absent"` (16b.1a's policy, applied to new code now; the lookup probe is unchanged until 16b.1a). A membership use of a rollup carries no `moves` (the reader's SQL reads rollup columns; the source route's gate already skips writes the rollup ignores). The probe body is shared with the lookup reverse map (`probeHosts`, rendering identical SQL).
- **`derived-tables`:** `CompiledRollupSource` gains `carryType` (the carry's SQL type; via.match's too), for the typed `via` probe. Signatures are over DDL only, so no rollup reinstalls.
- **C9 / D24 / A24:** `compileJoins` (window, `:rows`, `:groups`, union arm) refuses a rollup / children / closure join at module eval, naming it; `planGroupArm` reaches it through `compileJoins`. `compileAllJoins` refuses children / closure too (they are grouped CTEs, 16b.5 — never joined row-wise); its signature types them out. The kind is checked at the top of the plan loop, before the spec's table is read, so a closure (no `table`) gets the named refusal rather than drizzle's proxy `TypeError`.
- **A35 (pulled forward from step 21, review fixes):** `compilePlan`'s rollup case refuses, at module eval, a source whose `via.table` is not also a source of the same rollup that sees every re-key, naming the rollup, the source, the hop table and the gap. The check is one helper over the rollup's compiled sources, `assertHopsCovered(sources, refuse)` (joins.ts), so 16b.5's nested rollups (children / closure `rollups`) call it too, and it can move into `defineRollup` once step 21 makes `task_latest_conversation` two-source. The hop source must: carry `via.key` (with no `via` of its own); have `via.match` in its pk ∪ carry ∪ reads — else `UPDATE <hop> SET <match>` is skipped by both the maintain function's diff (the rollup TABLE goes stale) and the route's column gate; fire on `update` and `delete` — else the re-keying statement gets no trigger. `insert` is not required: a hop row's insert can only matter when rows already carry its match, which the owner's `ops` may rule out. Without it, `UPDATE attempts SET task_id='T2'` (or an RI cascade deleting the hop row) re-keys T1's rollup row with no route reaching host T1. This is the specific form of v2's A35 ("each reverse-probe hop table has a non-full route covering the hop columns"): the hop table as a source of the rollup is also what keeps the rollup TABLE correct, so a looser "any route of the plan on the hop table" would route a stale row. The production `task_latest_conversation` is still single-source until step 21 adds the attempts source; no `compileAllJoins` consumer exists before step 22, so nothing at boot is refused in the meantime — step 21 must land before 22's `all` reader, as the sequence already orders.
- **`derivedReads` (A1, A22, A8 — `resource-runtime/core/routing.ts`, `runtime.ts`):** `RoutePlanInput.derivedReads?: DerivedRead[]` (`{ table, sources }`, exported type); `ReachPlanInput.derivedReads?: never`. `mintRoutePlan` refuses a derived table a route names (A1), a source no route names (A22), a duplicate, an empty source list; mints the field only when non-empty. `RoutingRecord.derived` holds the tables, and `checkRouteDrift` accepts them in a capture. `JoinPlan.derivedReads` (each rollup table once) rides `routedReads` → `compiledRoutePlan(routes, usesOf, derivedReads = [])`.
- **C14:** `query-resource/server/internal/rollup-routes-layout.test.ts` (DB-backed): an `attempts` read joining `attempt_conv_agg` registers `conversations` carrying `attempt_id` in `routedTableRequirements()` (no rollup requirement); `rebuildTriggers` + `assertRouteLayoutsInstalled` pass; a conversations trigger installed without the carry is refused by A3, naming the trigger and column. `assertRouteLayoutsInstalled` is newly exported from change-feed's `server/testing`.
- **Tests:** `rollup-routes.test.ts` (every map shape and its probe SQL, over-cap, A4 refusals, A35 — single-source `latest`, a hop source carrying another column, one with no `delete`, one not reading a non-pk `match` refused, each naming its gap; `latestTwo` and the read-`match` hop accepted —, the fan-out in both roles, `derivedReads` dedupe, the minted field, C9 refusals in a grouping / `compileJoins` / `compileAllJoins`, tsc refusals); `runtime-table-routing.test.ts` §A22 (drift guard accepts a derived read under `strictRoutes`, still fails another table, layouts of the sources, every mint refusal, reach plan tsc).

### 16b.5 — `grouped.ts`, `compile-alias.ts`, lookup in `all`, the definition, the golden `all` group

- **Entry point (C3):** `compileAllCollection({ all, rows }, spec) → { all, rows, keyField, definition }` (`query-resource/server/internal/compile-alias.ts`), exported from the `server` barrel and from `server/testing` (its shipping caller, `serveCollection`, is 16b.6; until then only tests import it, so the public export has no importer and R13 is not tripped). `all`'s scope policy is the routed `scopedMembership` alias (`orderOf` = orderIds, `orderSignatureOf` read off the wire row's `orderBy` fields, as the union does); `:rows` is a point membership over the same routes and uses. `debounceMs` (C18) rides `all` only.
- **Spec — one plan, rendered through `bind`.** `select(bind)` / `where(bind)` get `j` (base and row-wise join columns as `ColumnRef`s, a grouped join's aggregates as `AggregateRef`s) and `render` / `aggregate` / `expr` over the compile's own plan, so every read is one the plan registered (an unrendered SQL fails `sqlTypeOf`). The host identity is the base table's single-column pk; the key field must read it. The order is the contract's `all.orderBy`.
- **Grouped joins (`grouped.ts`).** Children → one `GROUP BY fk` CTE `__c_<rel>` (nested rollups LEFT-joined inside, the `where` applied); closure → `__x_<a>` (pairs, recursive `UNION`), the ancestors' children CTEs `__c_<a>__anc__<c>`, and `__g_<a>` (per-node aggregates over the ancestor row `<a>__anc` + its rollups + its children CTEs). Each internal relation is its table aliased under that name and registered as a GROUPED relation of the plan: `compileAllJoins(base, rowWise, pk, label, grouped)` → `compilePlan`'s new `grouped` map (resolved for provenance, never walked or joined, never outer; `renderExpr` skips them in its wire check; `assertAggregateRelation` accepts them). `JoinPlan` gains `isGrouped(relation)` and `columnsIn(fragment, { direct: true })` (columns outside every aggregate). A row reads `COALESCE(<cte>."<name>", <ifNone>)`, registered through `renderAggregate` with provenance = body + fk (closure: child, parent) + the children `where` (C7).
- **Shapes.** Full / Scoped / orderIds / `:rows` as the header table of `compile-alias.ts`; A32's fences (`CROSS JOIN LATERAL (… OFFSET 0)` walk, `ANY(ARRAY(SELECT DISTINCT __a …))` InitPlan, pk lateral for the ancestor row) are in the scoped text and pinned by the unit test and the golden. The `all` refill casts ids `"throws"`, `:rows` `"absent"` (the absent form for a non-text pk is `pg_input_is_valid`).
- **Lookup in `all` (C5).** Row-wise joins (extension, lookup — required INNER included —, keyed side, top-level rollup) render through `fromSql` and route through `routedReads` exactly as in a window: the step-13 reverse routes and gates, unchanged (their `within` is still `"throws"` until 16b.1a). orderIds joins every INNER join plus the joins its `where` reads (A29).
- **Routes (v2's table, ids as internal relation names).** `<a>` alias on fk; `<a>__<r>[<src>]` reverse through the child rows; closure `<a>` alias on child, `<a>:closure` and `<a>__anc:closure` reverse to dependents, ancestor rollups / children `…:closure`. The dependents probe is `WITH RECURSIVE __d_<a>` walking down the edges by an `OFFSET 0` lateral over the parent index, `LIMIT cap + 1`, `within` in SQL up to 256 ids else filtered in JS. A source probe that would read the changed table after commit is `full` with a `pre-image needed` reason (A10). Every grouped route is read as `value`. Nested rollups' tables join `derivedReads` (deduped with the top-level ones).
- **Bind asserts.** A29, A35 (`assertHopsCovered` for every nested rollup, now exported from `joins.ts`), A37 (from drizzle's own index / pk / unique metadata at module eval — stronger than the boot rung v2 named), A38 (`CTE_NAME_RE`, lower-snake grouped aliases), A39 (type allowlist + no `withWire` via sql-column's `columnWireCodec`), C7 (a field reading no relation column; a grouped column read outside an aggregate), every declared grouped join read, a closure's `nodes` = the base table, key types, and `quotedRelationsIn(<each shape>) ⊆ route tables ∪ derived reads`.
- **Definition (`fingerprint.ts`, A18 / A40).** sha256 over the three shapes as `PgDialect.sqlToQuery` renders them (non-literal params refused), decoder ids, SQL types and nullability per field, `describeZod(contract.schema)`, `wire.ids`, each rollup's DDL hash, `orderBy`, keyField. Threaded as `compiledRoutePlan(…, definition)` → `RoutePlanInput.definition`.
- **Review fixes (16b.5).** Decoder ids are read through sql-projection's new `decoderOrigin` (`parsed` / `nullable` record what they wrap; the `{ mapFromDriverValue }` object `.mapWith(fn)` stores is unwrapped): column, native coercion, `parsed` (label + `describeZod(schema)`), `nullable(inner)`, and `jsonAgg`'s named `jsonAggValue` (core). Any other decoder — an anonymous or merely named function — is refused at bind, so an expression's or aggregate's decoder change always moves the definition. `encodeRow` and `wireIds` became one option `wire: { encodeRow, ids }` (empty `ids` refused). A nested rollup under a children join that neither its where nor an aggregate reads, and a closure ancestor join (rollup or children) no closure aggregate reads, are refused like an unread top-level grouped join. Tests: definition sensitivity to an aggregate's decoder alone (SQL byte-identical), an expression's decoder through `nullable`, a `parsed` schema alone, the row schema alone and a rollup's DDL alone; refusals for an opaque decoder, empty wire ids, both unread cases and A39's `withWire` jsonAgg column. The golden's tree definition moved (decoder ids are now read, not `value:object`); its SQL is unchanged.
- **Review fixes, round 2 (16b.5).** `describeZod` is fail-closed (`describeZodParts`): a `transform` / `preprocess`, a `catch`, a `default` that is not one stable JSON value and an unknown zod type are `{ $opaque }` markers listed by path (a literal default's value, a catchall, regex flags and array / set lengths are recorded; a refinement is data). A `parsed` decoder with an opaque part is refused at bind (A18). A `parsedText` / `parsedJson` column's id folds in `describeZod` of its schema, read through sql-column's new `columnSchema` (a WeakMap recorded on the built column, like `columnWireCodec`); an opaque part of a column's or the row's schema is folded in as a marker, NOT refused — the tasks entities' `tolerantEnum` columns (a `preprocess`) would otherwise refuse step 16b.6's tasks `all`. Tests: `fingerprint.test.ts` (each opaque kind by path, each recorded part moving the description, a recursive lazy terminating), `column-schema.test.ts`, definition sensitivity to a parsed literal default and a `parsedText` column's schema alone, the `parsed` opaque refusals, A10 (a nested rollup source on the child table, and closure ancestor rollup sources on the base and the edges, are `full`, `pre-image needed`; sibling sources stay `reverse`) and A35 under a children join and a closure's ancestors (hop not a source, wrong carry, no `delete`). Both golden `all` definitions moved (the description format changed); every SQL string is byte-identical.
- **Fixes found on the way.** `joins.ts`' `bareColumn` looped forever on a pure-literal expression (`sql\`1 + 1\``): a `StringChunk`'s `getSQL()` wraps itself, and JSC's proper tail calls turn the recursion into a spin. Leaf chunks now answer `false`. `raw-sql.ts` gains `anyOfExpr` (the same `anyOf` over an expression of a stated type); `anyOf`'s output is byte-identical.
- **Guard message** (`compile-window.ts`'s neither-window-nor-point refusal) now points at `liveCollection(key, { all })` / `compileAllCollection`; network/live's `compile-window.test.ts` regex updated.
- **Golden.** `compile-sql-golden.ts` gains an `all` group (a flat declaration with a parameterised `where`, a two-key order and `debounceMs`; a tree with a required lookup, a top-level via-rollup, children with a nested rollup and a `jsonAgg`, a second children join, and a closure whose ancestors carry the via-rollup and a children join). Regenerated; the `window`, `point` and `collections` groups are byte-identical to the pre-16b.5 fixture (checked group by group).
- **Tests.** `query-resource/server/internal/compile-alias.test.ts` (22 cases), `compile-alias-closure.test.ts` (A23: 200 seeded statements over a cyclic graph, a row-level change log so FK cascades count, route gates applied as the runtime applies them; asserts cycles were exercised and no route degraded to FULL), `tasks-core/server/internal/all-parity.test.ts` (Full ≡ `tasks_v` and `attempts_v`, active conversations with the owner joins ≡ `conversations_v` plus the lookups' real reverse probes, orderIds ≡ the declared order, scoped(S) ≡ full ∩ S and `:rows` likewise, all in transactions pinned to Europe/Paris with a DST change in the seeded instants, before and after trigger-maintained writes). Mutation checks: emptying `<a>:closure`'s resolve fails the A23 test; walking the closure's pairs by `child` instead of `parent` fails the parity test.
- **Parity fixture note.** `tasks_v` reads `conversations` directly for "waiting"; the compiled set reads it off the conversation rollup, so the parity suite installs `attempt_conv_agg` with step 19's `has_waiting_conv` column (same table name, source and reads, one more `bool_or`). The production rollup is unchanged until step 19.

### 16b.6 — `serveCollection`'s `all` arm, the runtime oracle, A30, A28's runtime half, the C39 harness and hydration test

- **The arm (C4, `network/live/server/internal/serve-all.ts`).** `serveCollection` checks `collection.all !== undefined` FIRST — before the lookup-only branch (`collection.window === undefined`), which would have served it as `:rows` alone — and the 16b.3 serve guard is gone. `compileAllSpecs` binds the row fields like the window path (by property name; overrides in `columns` over `j: AllJoinRefs` returning a column ref, an aggregate ref — `(j) => j.att.done`, its value type the field's, `| null` unless not-null, tsc — or an `expr`), passes `joins` (`AllJoinSpec`), a static `where` (over `AllWhereColumns`: the base's and the row-wise joins' raw columns, rollups included, never a grouped join) and `throttleMs` → `debounceMs` (C18), and calls `compileAllCollection`. Both halves are registered eagerly with `defineResource`; `ServedAllCollection` = `{ all, rows, keys: [key, key:rows], declare }`. `compileCollection` gains an `all` overload (`AllCollectionSpecs`, nothing registered), and dispatches to it first too. Exported types: `ServeAllCollectionOptions`, `ServedAllCollection`, `AllCollectionSpecs`, `AllWhereColumns`.
- **Refusals (module eval):** a cast making the collection `contributed`, `columnScope`d or a union; contributed / scoped sets handed to `compileCollection` beside an `all` collection; `serveContributed` reached by one (a guard behind the first-branch dispatch); a field that may read NULL on a non-null field (the window path's rule: a computed read's `canBeNull`, or a column through a LEFT join); a column ref `j` never offered; a wire-encoded value (sql-column `withWire`, an `expr`'s `wire`) — see deviations.
- **A30 (`resource-runtime`, `live-state-snapshot`).** `seedPersistedSnapshot` now answers a `SeedOutcome` (`seeded` | `skipped` | `invalid`, exported through resource-runtime and server-core) and `safeParse`s the value against the entry's payload schema before seeding anything; the raw value is what is seeded, as before. `runBootCatchUp` treats `invalid` as a missing row: logged to stderr, the row cleared (`clearPersistedSnapshots`, so boot-snapshot stops serving it) and the key recomputed; it does not lower the replay floor. A `skipped` seed still lowers it, as before. Review follow-up: the same parse alone, `validatePersistedValue(key, value)` (`PersistedValueCheck`: `valid` | `invalid` | `skipped`), is run by `initSnapshotSubsystem` in `onReadyBlocking` over every usable persisted alias row (`clearInvalidAliasSnapshots`), clearing the rows that fail BEFORE readiness flips — boot-snapshot's persisted fast path is open from readiness, before `onReady`'s seed, and would otherwise serve them. `runBootCatchUp`'s `invalid` branch stays as the backstop.
- **Module layout.** The source helpers both single-table forms share (`CollectionSource`, `TableOf`, `ColumnsOf`, `ColumnNamesOf`, `WireCheck`, `isEntitySource`) live in the leaf `network/live/server/internal/collection-source.ts`, so `serve-all.ts` and `serve-collection.ts` do not import each other.
- **A28, runtime half.** The scanner ≡ descriptor-registry half is 16b.3's `mints.test.ts`; 16b.6 adds descriptor-registry ≡ what `serveCollection` REGISTERS (`served.keys` for the window, lookup-only and `all` forms against the keys `liveCollection` minted), in `serve-collection-all.test.ts`. Together they chain the scanner to the server registry (see deviations).
- **`server/testing`.** `compileCollection` (now covering `all`) and the C39 harness `subscribeAsOldDescriptor({ key, schema }, { params?, build?, handler?, timeoutMs? })` → `refused` (`reason`, `verdict`) | `parsed` (the sub-ack value under the OLD schema) | `parse-failed`. It opens its own socket on server-core's runtime (or a given `notificationsWsHandler`), waits push-based for the tuple's `sub-ack` / `sub-error`, and closes it. Steps 18 and 19 run it against `task-categories` and `tasks` with their old row schemas.
- **Runtime oracle (`serve-collection-all-oracle.test.ts`)** — a throwaway database, the real routed triggers (`rebuildTriggers` from `routedTableRequirements()`), the LISTEN consumer and `routeChange` into server-core's runtime, L2 hooks installed for the key (so it is a persisted alias), a children join with a `count` aggregate and a base `where`. Each statement's exact cost, the subscribed `{}` view equal to a fresh FULL load after each: insert = one scoped refill + one `orderOf`; title update = one refill, no `orderOf`; rank move = one refill + one `orderOf`; a child insert = its host's refill, no `orderOf`; a where-flip out = a refill that omits the id (exit), no `orderOf`; a delete = no load at all; a where-flip back = an entrant. No FULL load after the subscribe. The `key:rows` point sibling is subscribed beside `{}` with `{ ids: "a,b" }` (canonical): after every statement its view equals the whole set's truth restricted to those ids — the child insert refills b's aggregate, the where-flip out makes a absent, the delete drops b, the flip back returns a — and none of its loads is FULL. Idle (unsubscribed): updates, an insert and a delete keep `keptSnapshotValue(key)` equal to the truth, scoped, never FULL; the trailing window's floor persist writes the current value; a fresh subscriber is served it. C39 harness cases: a byte-compatible old schema → `parsed`, equal to the truth; an old schema the rows no longer fit → `parse-failed` (no `skew` reaches the tab); an old tuple that SENT params → `refused`, `contract-mismatch`, `skew` (with an out-of-date build); a renamed key → `unknown-key`, `skew`.
- **C39 hydration (`boot-snapshot/web/__tests__/boot-all.test.ts`, jsdom).** The real live-state registry and the real `hydrateResource` (only the transport stubbed): a synthetic `liveCollection(key, { all, preload: "boot" })` resolves under `key` to its `all` descriptor (no `defaultParams`), and the boot task hydrates its param-less tuple; a value the row schema rejects is reported and not hydrated.
- **Other tests:** `serve-collection-all.test.ts` (both keys registered and loadable through the runtime; the grouped CTE, base `where` and order in the full SQL; `compileCollection` registering nothing, `throttleMs` → `debounceMs` on `all` only; an `expr` over an aggregate; every refusal; the tsc refusals — an aggregate's nullability, a non-column field without `columns`, an undeclared join, a children join on a lookup collection), `runtime-scoped-membership.test.ts` (A30: an invalid value seeds nothing and the first change rebuilds FULL; `seeded` / `skipped` outcomes — an unknown key and a registered non-alias entry skip even an invalid value, and a tuple already holding a fresher snapshot skips an invalid late value before any parse, its kept value untouched; `validatePersistedValue` answers `valid` / `invalid` and seeds nothing), `boot-catch-up.test.ts` (A30: the row cleared, the key recomputed, the other alias still seeded; `clearInvalidAliasSnapshots` clears only persisted alias rows that fail the parse, after which `runBootCatchUp` recomputes that key instead of seeding it).
- **Docs:** network/live CLAUDE.md (*Serve → The `all` arm*, the C39 harness), query-resource CLAUDE.md (the shipping caller), resource-runtime CLAUDE.md (`SeedOutcome`, A30), live-state-snapshot CLAUDE.md (boot flow step 4, the test list), boot-snapshot CLAUDE.md (an `all` key is a default tuple); barrel descriptions regenerated by the build.

### 16b.7 — `useLive(all)`, the derived gate latch (C17, D29), the C39 render test

- **Overloads (`network/live/web/internal/use-live.ts`).** After the window and group overloads, before `{ ids }` and the value overloads: `useLive<Row>(all: LiveAllCollection<Row>) → ResourceResult<Row[]>` and `useLive<Row, S>(all, { select }: LiveAllSelect<Row, S>) → ResourceResult<S>` (`LiveAllSelect` exported from the web barrel). The implementation dispatches on the collection carrying `all` (a lookup collection's is `undefined`, a window one has none) unless the query is `{ ids }`, to `useAll` → ONE call, `useResource(all, undefined, { gate: true, select: options?.select })` — a gated read whose selector is optional (`UseResourceGateOptions`, a third `useResource` overload), so the hook has no conditional call (rules-of-hooks). A plain read hands React Query NO `select`, so its `data` IS the cached array and every observer shares it and its row objects (review fix: an identity `select` made React Query structurally share each observer's own copy — a new array and new changed-row objects per observer per push, defeating the TaskGraph `WeakMap`); it narrows to `["data", "error"]` once the tuple has a value exactly like a select read, so a push that changes nothing re-renders nothing. `useLiveRow(all, id)` and `useLive(all, { ids })` needed no new overload: `LiveAllCollection` already extends `LiveRowsCollection`, and the dispatch sends `{ ids }` to `:rows`. `useLive(lookup)`, `useLive(lookup, { select })` and `useLive(all, { limit })` stay tsc errors (tested).
- **Derived latch (`primitives/live-state/web/use-resource.ts`, app-wide per D29).** The `settledKey` state and its settle effect are gone. `useTupleHasValue(queryClient, queryKey, enabled)` reads `cache.get(hashKey(queryKey))?.state.dataUpdatedAt !== 0` through `useSyncExternalStore`, woken only by its own tuple's events. Notifications narrow (`notifyOnChangeProps: ["data", "error"]`) exactly when `!gate || tupleHasValue`.
  - **The cache listener lives only while the latch is open (review fix).** `QueryCache.notify` runs every listener on every cache event of any query, and in @tanstack/query-core 5.99 every observer of a pushed tuple emits an `observerResultsUpdated` event per update, so a listener held for a gated read's lifetime made a push cost ~N×K calls (N observers of the tuple, K gated reads app-wide — R² for R per-row `useLive(all, { select })` readers). `subscribe` now adds no listener when the read does not gate or its tuple already holds a value, and an open read's listener removes itself with the event that lands the value. The flag is read inside `subscribe` rather than passed in deps: the latch's value only exists AFTER `useSyncExternalStore` returns, and an in-render cache read is what the React Compiler could memoize stale. A later reset (value → epoch 0) needs no listener: it changes `data`, so the narrowed observer re-renders and re-reads the snapshot, and the widened observer it becomes re-renders on the next `dataUpdatedAt` change.
  - **A selector that may be absent is typed `T | S` (review fix).** The third overload (`UseResourceGateOptions<T, S>`, optional `select`) returns `ResourceResult<T | S>`, not `ResourceResult<S>`: a `select: cond ? f : undefined` read hands back the whole `T` when `f` is absent. `{ gate: true }` alone is `ResourceResult<T>` (`S` defaults to `T`); an always-present selector still matches the `UseResourceOptions` overload (`ResourceResult<S>`). `useAll` returns `ResourceResult<unknown>` and the `useLive` overloads fix the type, so nothing else moved.
  - **The `select` is now applied on every render; only the notifications are gated.** Toggling `select` off while re-gated and on again let React Query (`QueryObserver.#selectFn` / `#selectResult`) return the slice memoized for the PREVIOUS tuple after a params change: the new params-change latch test failed with the previous tuple's slice until this change, and by the same reading of the observer the old `settledKey` latch had it too (select off until its effect turned it back on). With the selector always set, the manual "gate transition" `select(q.data)` arm is gone too: `q.data` is always the query's own slice.
- **Tests.**
  - `network/live/web/__tests__/use-live-all.test.tsx` (jsdom): a boot-hydrated read (the boot snapshot's `hydrateResource` on the app's default client) renders ONCE, ready, plain and with a `select`, with no `fetchOverHttp` / `primeFromHttp` and the `{}` tuple observed (C39); loading until the first value; `data` and the result identical with no push (a push to another key included); a delta keeps untouched rows' identity; two plain observers both hold the cached array and the cached changed row after a delta, and an equal full value re-renders neither; a push leaving a select's slice alone (a value change of another row, an `order` delta) does not re-render it, one moving it does; an `order` delta reorders and keeps every row's identity, moved ones included; id reads go to `:rows` and never read the whole set; the overload types. Deltas are applied as the client applies them: `mergeKeyedDelta` (now exported from `live-state/web/testing`) over the cached rows, then `setQueryData`.
  - `primitives/live-state/web/__tests__/use-resource-gate-latch.test.tsx` (jsdom, beside `use-resource-error-gate.test.tsx`): a cached tuple renders once, ready and narrowed; an uncached one flips loading → ready even with the slice unchanged across the boundary; once settled a slice-preserving push re-renders nothing and a slice-moving one does; a params change re-gates an uncached tuple (and serves ITS slice) and starts narrowed on a cached one (exactly one render); a read whose tuple holds a value adds no query-cache listener, and an open read's one listener is gone once the value lands (counted through a `cache.subscribe` spy); a maybe-absent selector types the read `T | S` (`@ts-expect-error` on `ResourceResult<S>`).
- **Moved rows keep their identity (review fix).** `applyDelta`'s merge reuses the row objects, but the cache write went through `dateAwareReplaceEqualDeep`, which shared structure by INDEX only, re-minting every row an `order` delta moved. `structural-sharing.ts` now keeps, after the positional match fails, an array element that IS by reference an element the previous array held (generic — no `keyOf`, so it is safe for select outputs too, and never weaker than positional sharing: the positional match is tried first). Pinned by `internal/structural-sharing.test.ts` and the jsdom reorder test (now `toBe`). A full snapshot (freshly parsed rows) still shares positionally.
- **Docs:** network/live CLAUDE.md (*Read* — the `all` reads; the `all` bullet), live-state CLAUDE.md (*Slice selectors* — `useLive(all, { select })`, the derived latch, a gated read with no selector, structural sharing of moved elements; *Keyed delta sync*), the `gate` JSDoc; the web barrel description.

### 16b.8 — docs

- **CLAUDE.md sweep** over the 16b list (network/live, query-resource, resource-vocabulary, codegen, derived-tables) and the 16a list (resource-runtime, live-state-snapshot, boot-snapshot, boot-bench, `debug/read-set-shrink`). Most of each was written by its own step; this pass removed what those steps left stale:
  - network/live: an `all` example in *Usage*; *Declare* no longer says there is no unbounded spelling; *Preload* names `key`'s `{}` tuple; *Internals* lists the `{ row, id, all }` form; *Wire params* gains the `all` row (`{}` only).
  - query-resource: the `queryResource` bullet now says the tree keys move to `all` in steps 18–22 and the form is deleted at 23; *Routes* lists `compileAllCollection` and the union as routed and gains an `all` bullet; *Arms and assembly* states the assemblers take exactly one arm; `AllQueryResourceContract` moved from *Rollup routes* into *The `all` compiler*; *Raw SQL helpers* and *Aggregates* name the `all` compiler as the consumer. The server barrel description names the `all` compiler.
  - resource-runtime: *ScopePolicy* answers both questions for the routed arms (`routes` + `membership` / `scopedMembership` with `orderSignatureOf` required); the membership intro no longer says only `identityTable` supplies the identity.
  - codegen: a hand-written *Eager tier* section (preload pins read through `mintsOf`, `requires`).
  - resource-vocabulary: the collection / served-collection matchers are described as matching `rows` (every form, `all` included), here and in `vocabulary.ts` / `check/index.ts`.
  - derived-tables: the A35 consequence for a collection joining a rollup whose hop is not a source.
  - boot-snapshot: the L2 set is `persistedKeys()` through the usable-row predicate; the cold-boot paragraph names the alias seed and the backstop. boot-bench: `persisted` means a usable row. live-state-snapshot: `./equin test`, not bare `bun test`; the server barrel description (usable row, persist modes, compact, seed + backstop).
- **Code comments:** `compile-window.ts` (header: the whole-set sibling is `./compile-alias`; the assemblers take one arm, the union and `all` compilers share only the routed half; the signature-field loop; `windowQueryResource`'s docstring no longer compares with `queryResource`), `raw-sql.ts` (the `all` compiler, not "the persisted alias next"). `arm-plan.ts`, the `rollup-spec.ts` W8 comment and the guard message + test regex were already done by 16b.2 / 16b.4 / 16b.5.
- **Review fixes.** The signature-field loop in `assembleWindow` is deleted: the `readonly [WindowArmPlan]` 1-tuple already makes a second arm unwritable, so its guard could never fire (the type is the rule's strongest form). The docstring now says "over its one arm" and names the union and `all` compilers as the routed-half sharers; *Arms and assembly* no longer lists a cross-arm signature check. network/live *Preload* is split by form: a window collection hydrates `defaultParams`, an `all` collection hydrates `key` at `{}` (it has no `defaultParams`); `"boot-and-keep"` keeps the preloaded tuple's cache resident.

### ★17 — benchmark gate (2026-10-07, build `dece612040-1791374039732`)

The full report is in the session scratchpad (`bench17/`). Summary:

| Check | Result |
|---|---|
| Compiled `tasks` full vs `tasks_v` | main 0.38× (18.7 vs 49 ms); fork 0.86–0.95× (fork `tasks_v` is only about 19 ms); 3.5× fewer buffers. Parity: all 5,027 rows; scoped ≡ full on 80 ids |
| Compiled `attempts` full vs the legacy pair (D11: 2.4× accepted) | exec: **main 3.4–3.7×** (about 17.5 ms vs about 5 ms), fork 2.05×; wall on the fork 1.1–1.8× |
| Scoped closure (D12) | p50 0.58, p95 0.78, max 2.69 ms; worst chain (52 deep) 0.64 ms; refill of the task with the most dependents (78 ids) 5.96 ms |
| Order frames (D13) | tasks 140.6 KB, attempts 104.4 KB (full values: 2.23 MB / 2.47 MB) |
| Closure pairs | 12,224 |
| Trigger time | Every table is the same or faster than the 16·0 baseline (conversations status 1.05 → 0.49 ms; `waiting_for` 0.79 → 0.21 ms), except UPDATE `attempts.task_id` 0.15 → 0.21 ms |
| Rollup churn across a restart | 0 updates (the per-boot rewrite is gone) |
| Cold boot, L2 swept (contended host) | boot-snapshot median 774 ms |
| Catch-up, about 1 h floor | 1,149 rows replayed; on main, 151 per hour on tree tables |
| D23 | **Pass:** grouping Runs sends no `runs:groups` subscription |

Caveats:
- The trigger-time script's committed throwaway delete leaves `task_latest_conversation` drift (W8) until step 21, so the boot after it takes the backstop path.
- Warm-mode `benchmark_boot` rejects the `memory` source until main has 16a's enum.

**After ★17 (2026-10-07):**
- The user said "continue", which is taken as accepting D11 at the measured 3.4–3.7× exec on main and the 16b.3 framework edits.
- The branch was rebased onto `origin/main` (32 commits) with no conflicts.
- Steps 18–22 follow.

### 18 — `task-categories` as an `all` collection; the tree oracle and `tree-live-verify` bootstrapped (2026-10-07)

- **Declaration** (`task-category/shared/resources.ts`): `taskCategories = liveCollection("task-categories", { row: TaskCategoryRowSchema, id: "taskId", all: { orderBy: [["taskId", "asc"]], unbounded: { reason } }, preload: "boot" })`. The legacy `queryResourceDescriptor` is gone. The declaration is plugin-private: the web barrel no longer exports `taskCategoriesResource`, `TaskCategoryRowSchema` or `TaskCategoryRow`, and the server barrel no longer exports `taskCategoriesServerResource`. The (K) note's "`core/index.ts:47-51` in each step" names tasks-core's core barrel, which never exported this key, so step 18 had nothing to remove there.
- **Serve** (`server/internal/resource.ts`): `serveCollection(taskCategories, taskCategoriesServeOptions)`, contributed as `...taskCategoriesServed.declare` (`task-categories` and `task-categories:rows`). The options (`{ from: tasksCategory }`) live in their own module, `serve-options.ts`. The oracle can then compile the REAL options against a throwaway database without importing `resource.ts`, whose import would register the key on the real database.
- **Routed layout:** after the deploy, `tasks_ext_category`'s three `live_state_*` triggers run `live_state_notify_routed`. Before, they ran the plain PK-only `live_state_notify`. L2 holds a `task-categories` row with a definition, `definition_at = persisted_at`, and `tables_read = {tasks_ext_category}`.
- **Readers:** `useTaskCategoryMap()` is `useLive(taskCategories, { select: toCategoryMap })` → `ResourceResult<ReadonlyMap<taskId, categoryId>>`, with a module-level selector. `useTaskCategories()` is `useEndpointResource` → `ResourceResult<TaskCategoryDef[]>`, which fixes the loading→`[]` collapse.
  - `CategoryField` folds both reads. While the set has never loaded, a task's value is `null` (no claim is drawn from it), and a failed read keeps `stale`. This is the `TrackField` precedent. The registry's options are `[]` until it loads; that is an option list, not a claim about a task.
  - `TaskDependenciesActions` renders no header actions until the map is known: an unknown category is not the `root` target.
- **Lint:** the three `· task-categories` lines are removed from network/live Item 3. `task-dependencies.tsx` stays under `· tasks`.
- **C39 (old bundle):** checked against the REAL key with the 16b.6 harness. An old-descriptor subscription with `{}` gets `parsed`, equal to the kept set. This holds both under a literal `.strict()` copy of the legacy row (`{ taskId, category }`, so a field added to the row would fail the parse) and under `z.array(TaskCategoryRowSchema)`. The rows are byte-compatible, so the key keeps its name.
- **Tree oracle (new).** The harness is `tasks-core/server/testing/tree-oracle.ts`, exported from tasks-core's `server/testing`:
  - `createTreeOracle({ prefix, persisted })` sets up a throwaway database with `runMigrations` and `installTaskDerivedSchema`, installs L2 hooks for the persisted keys, and exposes `registerAll(collection, compiled specs)` (loads and `orderOf` counted per key). `start()` runs `rebuildTriggers` from `routedTableRequirements()` (the rollup tables are feed-exempt), starts the LISTEN consumer feeding `routeChange`, and opens one socket on server-core's notifications handler.
  - `subscribe` / `unsubscribe` manage tuples. `run(step)` executes a step's SQL, waits for a routed change and then for quiet, and returns the per-key loads and `orderOf` calls.
  - `converged(label)` checks every subscribed view (a `:rows` view compared by key) and every persisted key's kept `{}` snapshot against a fresh FULL load.
  - The scripted workload is `treeSeed()` (5 tasks, 3 edges, 2 attempts, 2 conversations, 1 push) and `treeSteps()` (15 steps: task insert, edge insert, rename, hold, attempt insert, conversation insert, conversation done, poller write, push, drag reorder, attempt moved between tasks, edge delete, attempt cascade delete, task cascade delete, drop). `withSteps(base, { afterLabel: steps })` splices a suite's own steps in and throws on an unknown label. `TREE_IDS` exposes the fixed ids.
- **Where the oracle suites live (deviation).** Each tree entry is tested in its OWNER's suite, on the shared harness:
  - task-category (and agents at step 21) sit downstream of tasks-core. A tasks-core test importing them would close an R6 cycle, because test files count in the server graph.
  - `tasks-core/server/internal/tree-oracle.test.ts` therefore drives the workload against a PROBE. The probe is an `all` collection over `tasks` with a `childrenJoin` count over `attempts` and a `dropped_at IS NULL` base `where`, which is the shape the conversions take.
  - For every step it pins the probe's exact cost: insert is an entrant (`[T6]`, 1 `orderOf`); rename is an order move (`[T2]`, 1); hold, edges, conversations, push and reorder load nothing (route gate or table not read); an attempt insert or delete is one host refill; an attempt move is one load `[T2,T4]`; a task delete is an exit with no load; a drop is a where-flip refill `[T4]` that omits the id. No FULL load happens after the subscribe. It also checks the idle `{}` snapshot.
  - `task-category/server/internal/task-categories-oracle.test.ts` runs the same workload with the category writes spliced in. A category set is `[id]` plus 1 `orderOf`; a change is `[id]` with 0; a clear is no load; the task delete (an FK cascade of its category) is no load; every other tree write is no load.
  - It subscribes `{}` and `:rows` (two ids, one cascade-deleted mid-script). Both converge after every step, and neither has a FULL load after the subscribe. With no subscriber, a floor persist writes the kept value. The suite ends with the C39 case.
- **Open item for step 19.** `bun test` runs all files in ONE process (`./equin test` does not isolate them). A suite that registers a REAL tasks-core key (`tasks`) on the oracle will collide (`defineResource: duplicate key`) in any run that also loads a test importing the tasks-core SERVER barrel, because that barrel's `resources.ts` registers the real key on the real database. `deps-tree-move.test.ts` and the all-conversations suites import it today. Step 19 must solve this structurally, either by moving the served declarations out of the barrel's import graph or by giving the runtime a test seam. It must not loosen the duplicate guard. Step 18 does not hit it, because no test imports `task-category/server`.
- **`tree-live-verify` (new):** `tasks-core/e2e/tree-live-verify.ts`. It seeds an inert task through the deploy DB (prefix `e2e-tree-`, swept on exit), opens `/agents/tasks`, and records the socket frames and every HTTP read of a tree key. It contains the step-18 phase; steps 19–22 add theirs. Run on this deploy (build `6b4c1c8223-1791383823582`), **ALL CHECKS PASSED (7)**:
  - a category set arrives as one upsert of `{ taskId, category }`, and no frame re-sends the whole set;
  - a change arrives as one upsert;
  - a clear arrives as a delete;
  - there is no HTTP read of `task-categories` after first paint, and no reload;
  - the reload's `boot-snapshot` carries the task's current category.
  - Noise, both non-fatal: three `429` console errors from the gateway on a contended host, and the post-reload screenshot timing out.
- **W-checks (`get_runtime_profile`, worktree deploy, over the e2e and the trigger-time run):** `task-categories` had 5 push-origin loads, avg 3 ms and max 4.9 ms (`measuresMax.ids` 8), all scoped. A FULL load over the 3,004-row set would cost about 15–22 ms; that is what the two `sub`-origin loads cost, one per page load: the initial subscribe and the reload's.
  - **W1/W2 for this key:** an insert is an entrant, a delete is an exit, and an update is a one-row refill, never FULL on a change. This is pinned exactly by the oracle.
  - **W4:** the set reads only `tasks_ext_category`, so tree writes reach it with no load (oracle).
- **Trigger time** (`--repeats 9`, the 16·0 pinned fixture; JSON in the session scratchpad as `trigger-time-18.json`). The host was more contended than at 16·0: the empty-transaction COMMIT measured 0.181 ms against 0.036 ms, and `DELETE task_dependencies`, whose layout did not change, measured 0.041 → 0.116 ms exec (trigger 0.033 → 0.090 ms, about 2.7×).
  - **UPDATE `tasks_ext_category`** (the one table whose layout changed): exec 0.057 → 0.233 ms; `live_state_tasks_ext_category_u` 0.040 → 0.206 ms (about 5×; the routed trigger builds old/new rows). Net of the run's ~2.7× noise, that is roughly 2× the PK-only trigger, about 0.1 ms per statement.
  - Other rows of this run, for the record: `UPDATE tasks status` 0.32 ms; `INSERT attempt` 0.127; `UPDATE conversations status` 0.966; `waiting_for` only 0.331; `INSERT pushes` 0.334; `INSERT task_dependencies` 0.196; `DELETE attempt` (cascade) 1.017; `UPDATE attempts.task_id` 0.267. COMMIT with throwaway rows 0.426 ms.
- **Tests:** `./equin test plugins/tasks/plugins/task-category plugins/tasks/plugins/tasks-core plugins/tasks/plugins/task-dependencies plugins/network/plugins/live` → bun 518 pass across 50 files; vitest 52 pass across 3 files.
- **Build:** green (`6b4c1c8223-1791383823582`).
- **Docs:** task-category CLAUDE.md (the `all` set, its costs, the C39 note, the tests). The tasks-core testing barrel's autogen lists the tree-oracle helpers.

### 18 (review round) — the oracle on its own runtime, pending fields in data-view, the e2e races (2026-10-07)

Applies the step-18 review. Earlier text is unchanged. Where it disagrees with this subsection, this subsection is the current state.

- **Blocker: the oracle collided with the global registry. Fixed by giving the tree oracle its own runtime (option one).**
  - The step-18 open item was wrong to say step 18 is unaffected. It only checked direct imports. `conversations/server/internal/auto-start-launch.test.ts` → `auto-start-jobs` → `lifecycle` → `@plugins/tasks/plugins/task-category/server` (`setTaskCategory`) evaluates `resource.ts`, which registers the real `task-categories` key on server-core's global runtime. The oracle then registered the same key a second time and got `defineResource: duplicate key "task-categories"`.
  - `createTreeOracle` now builds its own runtime with `createResourceRuntime({ shouldPersist, captureWatermark, persistSnapshot, reportError })`. Registration, the trigger layout (`runtime.routedTableRequirements()`), the socket (`runtime.notificationsWsHandler`), the kept snapshots and `dropPendingPersists` all go through that runtime. The oracle no longer calls `setLiveStateSnapshotHooks` or the global `defineResource`. `TreeOracle.runtime` is exposed, so the C39 case passes `handler: oracle.runtime.notificationsWsHandler` to `subscribeAsOldDescriptor`.
  - change-feed: `routeChange` is now `createChangeRouter({ routeTableChange, applyDbChange })`, bound to server-core's routers. The factory body is the old function with no behaviour change. It is exported from change-feed's `server/testing` only, and the oracle routes its LISTEN consumer through `createChangeRouter(runtime)`.
  - The duplicate guard is untouched. Two oracles can now coexist in one process, so the "one harness per process" note is gone.
  - **The step-19 open item is closed by the same change.** Registering the real `tasks` key on the oracle can no longer collide with suites that import the tasks-core server barrel, because the oracle never touches the global registry.
  - Repro (`./equin test` on `auto-start-launch.test.ts` + `task-categories-oracle.test.ts` + `tree-oracle.test.ts`): before, 7 pass and 1 fail (duplicate key). After, **12 pass, 0 fail**.
- **Major: the loading collapse in `CategoryField`. Fixed in the data-view primitive.**
  - `FieldDef` gains `pending?: boolean`, meaning the field's own values are not known yet. While it is set, `FieldCell` draws the loading block. `resolveBodyState` takes `readFields`, which `fieldsReadByView(fields, activeState)` computes: the group-by field, the sort fields, and every field named in the filter and fold trees.
  - The body's precedence is now `server error > failed read > failed field > loading > pending field > the view`. A view laid out by a pending field renders its loading state. A view laid out by a field with `readError` renders that failure (a new `field-error` arm in `BodyFallback`, which names the field and offers Retry) instead of filing every row under the field's unset bucket.
  - `CategoryField` folds the map into `pending | known | failed`. Pending sets `pending: true`. Failed with no stale value sets `readError` (with the read's `refetch`). Failed with a stale value keeps painting that value. `value` gives `null` only for a known map, so `null` now always means "no category".
  - `TrackField` had the same defect: grouping by track while it was pending bucketed every task into one group. It moved to the same states. Its hand-drawn loading cell is gone, and a failure with no stale value is now `readError` instead of an endless loading cell.
  - Tests: `body-state.test.ts` covers the pending case, the failed case (naming the field, carrying `refetch`), the rows' own failure outranking a field's, and `fieldsReadByView` (nested filter group, fold, an id no field answers to).
  - Docs: data-view CLAUDE.md, under "A field's own read" in Field extensions, plus the readiness precedence line. task-category CLAUDE.md.
- **Minor: `converged()` skipped a missing kept snapshot. Fixed.** A persisted key that was ever subscribed must hold a kept snapshot; if it has none, `converged()` throws `no kept snapshot for <key> after "<label>"`. `converged()` also throws when the runtime reported a failure (loader, drain or persist) since the last call. The oracle's `reportError` collects these instead of server-core's reporter.
- **Minor: the e2e reload raced the last write. Fixed.** The final `agents` set is now awaited as an upsert frame before the reload, which adds an 8th check. The docstring no longer claims a DOM check: the checks read socket frames and the boot-snapshot body only.
  - **A second race the rerun exposed, also fixed.** On a contended host the socket's own subscribe can land seconds after first paint (which comes from the boot snapshot). Two reruns saw the measured window contain a burst of `sub-ack`s for every key on the page (`icons.sprites`, `config-v2.values`, row keys and `task-categories`), which tripped "no frame re-sent the whole set". The script now waits for each tree key's `sub-ack` before it measures, and the check's detail lists the frame kinds.
- **Minor: the query-resource CLAUDE.md example. Fixed.** The example is now the still-legacy `tasks` declaration (`queryResourceDescriptor` + `queryResource(tasksDescriptor, { from: tasks, identity })`), and the text notes that `task-categories` moved to `all` at step 18.
- **Not done:** `apps/file-explorer/git`'s `GitFields` hand-draws a pending cell the same way `TrackField` did. It could adopt `pending` as well, but it is outside the tree and was left as is.
- **Lint Item 3:** nothing new for step 18; the `· task-categories` lines were already removed.
- **Trigger time:** not re-measured, because no table's trigger layout changed in this round. The step-18 numbers stand.
- **W-checks (`get_runtime_profile`, deploy `6b4c1c8223-1791388654162`, after the e2e):**
  - `task-categories` had 6 loads. Two were `sub`-origin (the subscribe and the reload, 18.5 / 16.5 ms over the whole set).
  - Three were `push` loads from the e2e's set, change and reset, all scoped (`measuresMax.ids` 1).
  - One was a `push` load at 2.7 s after the backend booted (65 ms, no ids). That is the boot-time L2 recompute, not a change-driven FULL.
  - The clear cost no load. **W1/W2 hold for this key.**
- **e2e:** `tree-live-verify.ts` on this deploy reports **ALL CHECKS PASSED (8)**. Noise, all non-fatal: `429`s from the gateway and one `Failed to fetch` page error on the contended host.
- **Tests:**
  - `./equin test` over task-category, tasks-core, task-dependencies, task-track, network/live, data-view, change-feed and `auto-start-launch.test.ts`: bun **894 pass / 0 fail** across 91 files; vitest 228 pass.
  - Two vitest suites (`hosted-toolbar`, `sections-toolbar`) timed out at 5 s on their first render while the host was under duress. Rerun alone, they passed **18/18**.
- **Build:** the first rebuild failed type-check. `foldResource` inferred its union from the first handler, a test call repeated `readFields`, and a manual `useMemo` over `activeState` broke React Compiler memoization. After those fixes the build is **green** (`6b4c1c8223-1791388654162`).

### 18 (review round 2) — the category registry folded into the field, the effective fold, exact point-reader costs, the e2e windows, the prune horizon (2026-10-07)

- **The category field waits for BOTH reads.** The registry was still folded into `options: []` while it loaded. A category-grouped view then laid out raw-id sections in id order, which relabelled and reordered when the registry arrived. A registry failure with nothing held was swallowed.
  - `web/internal/category-read.ts` now combines the two reads (`readOf`, `categoryFieldRead`) and builds the field from them (`categoryFieldDef`).
  - The field is `pending` while either read loads. It carries a `readError` when either read failed with nothing held: the map's failure first, then the registry's, each with its own Retry.
  - `options` and `value` are only emitted once both reads are known.
  - New `category-read.test.ts` covers the case where the view is grouped by category while the registry is pending.
  - I did not preload the registry in the boot snapshot. The registry is an endpoint read, so a cold tab shows the loading state for one round-trip instead.
- **`TaskDependenciesActions`:** a failed categories read with nothing held now renders `ResourceErrorInline` (inline, with Retry) where the actions were. It used to return `null`.
- **The fold in effect.** `fieldsReadByView(fields, state, fold)` now takes the fold as its own required argument. The body passes the effective `fold`, which is suspended while a search is typed and absent in a view without fold lines. A stored fold over a pending field therefore no longer holds the body. Making the fold a required argument means a caller cannot fall back to the stored fold by accident. `body-state.test.ts` covers both arms.
- **The oracle pins the `:rows` point reader per step** (point set T1, T2): `[T1]` on `category.change`, and nothing on every tree write or on category writes to T3 or T6. A final check requires that every point load after the subscribe is one a step pinned. Two steps are new:
  - `category.same`: the filing path's re-file, an `ON CONFLICT DO UPDATE` that leaves the category unchanged. It costs **0 loads on both readers**, because the route gate drops it.
  - `category.change-two`: one statement that changes T1 and T3. It costs **one refill `[T1, T3]`, no `orderOf`**, and the point reader refills `[T1]` only.
- **e2e windows.**
  - `httpReads` now resets right after `boot()` returns at first paint, so the window up to the socket's own subscribe counts.
  - The frame-delta window still starts after the sub-acks.
  - The "no whole-set value frame" check now runs once over every frame from the start of measurement to the end of the phase. It used to cover only the frames up to each upsert.
  - Result: still **ALL CHECKS PASSED (8)**. The stricter windows found no HTTP read of `task-categories` and no whole-set re-send.
- **The prune horizon (pre-existing, from 16a).** `isPrunedPast` treated "oldest retained changelog xid > floor" as "pruned past the floor". The changelog is sparse, so after any prune the oldest survivor sits above the floor with nothing missing in between, and every boot after a prune cleared and recomputed all 11 persisted keys.
  - A one-row `live_state_changelog_horizon` table now records `max_pruned_xid`. It is created by `ensureSnapshotTable` and registered in `IMPERATIVE_PUBLIC_TABLES`.
  - The prune moves the horizon in the same statement as the delete (`pruneChangelog`: `WITH pruned AS (DELETE … RETURNING xid) INSERT … ON CONFLICT DO UPDATE SET … GREATEST`), so the horizon only ever goes up.
  - Catch-up now backstops only when `horizon ≥ floor`: in the probe, and for each seeded row in `runBootCatchUp`.
  - A missing horizon row is seeded with the most that could have been pruned: below the oldest retained row, the current xid if the changelog is empty, and NULL if there is no changelog yet. This is the old rule, frozen at that moment.
  - The horizon is not excluded from forks. xids are cluster-wide, so a copied horizon lies below every position the fork will persist.
  - Tests:
    - `catch-up.test.ts`: the reviewer's case (floor 100; rows at 90, 95 and 105; the prune leaves horizon 95; the result is `replay`, and only 105 is replayed), the ceiling backstop, the horizon never moving down, and the seed.
    - `boot-catch-up.test.ts`: now drives the real prune.
  - On this deploy (`6b4c1c8223-1791394888817`) the horizon seeded to 28604792 (the oldest retained xid minus 1) against floor 28638037, and the boot replayed (866 and 930 rows, from the two backends of the hot swap). It did not backstop.
- **Correction to the previous subsection.** It called the 65 ms load with no ids at boot "the L2 boot recompute". That load was the **heal backstop**: at 1791391510 the log says "boot reconcile healed rollup(s) task_latest_conversation", which is the W8 drift that the trigger-time run left behind. Separately, the backstop at 1791393260 ("oldest retained changelog xid 28604793 > snapshot floor 28604790") is the false positive that this round removes.
- **Measurements:** no table's trigger layout changed in this round, so trigger time was not re-measured.
- **Tests:** `./equin test` over task-category, task-dependencies, tasks-core, data-view, live-state-snapshot, derived-views and migrations: bun **653 pass / 0 fail** (66 files); vitest **178 pass** (34 files).
- **Build:** green on the first attempt (`6b4c1c8223-1791394888817`).
- **Runtime profile** (`6b4c1c8223-1791394888817`, read after the e2e): `task-categories` loaded 6 times.
  - 2 loads on subscribe (the first one and the reload's): 19.1 ms and 18.4 ms.
  - 4 push loads, each scoped to at most 1 id. One of them ran 2.4 s after boot: that is the boot catch-up's replay, scoped and 13.6 ms. The rest come from the e2e's writes.
  - No load without ids and no full load. The 65 ms boot recompute from the previous round, a heal backstop, is gone on this boot. W1/W2 hold for the key.

### 19 — `tasks` as an `all` collection; `taskDescriptions` replaces `taskDetail`; shared derivations; `tasks_v` off `conversations` / `pushes` (2026-10-07)

- **Rollup.** `attempt_conv_agg.has_waiting_conv = bool_or(status = 'waiting')` (`rollup-table.ts`, `rollup-spec.ts`; same source and reads). The changed table shape made the boot DROP + recreate it, and the reconcile healed it. That is the expected one-time heal, and the A20 backstop then cleared and recomputed all 11 persisted keys ("the boot reconcile healed rollup(s) attempt_conv_agg"). After the deploy, 35 rows have `has_waiting_conv`, which equals the 35 attempts that have a waiting conversation.
- **Shared derivations (`tasks-core/server/internal/derived.ts`).**
  - `attemptDerived` (status, completed, active, retained, finishedAt);
  - `taskAttemptAggregates` (hasAttempt, hasCompleted, hasActive, hasWaiting, minPushAt; a fourth builder, see deviations);
  - `taskDerived` (status, active, finishedAt);
  - `depIsBlocking({ droppedAt, heldAt, hasCompleted })`.

  Each builder takes its facts as operands (`SqlOperand`: a drizzle wrapper, a query-resource `ColumnRef` or an `AggregateRef`) and returns fresh SQL per call.
  - `attempts_v` and `tasks_v` interpolate the builders.
  - `task_blocking_v` and `directDepIsBlocking` interpolate `depIsBlocking`, with `hasCompleted` = an `EXISTS` over `attempts_v`.
  - `tasks_v`'s per-task CTE now groups `_attempts` LEFT JOIN the two rollups and no longer reads `attempts_v`. Its `task_waiting` and `task_completed_push` CTEs are gone. Its `dependsOn` is now `["task_blocking_v"]`.
- **`view_table_usage` after the rebuild:**
  - `tasks_v` = attempt_conv_agg, attempt_push_agg, attempts, task_blocking_v, task_dependencies, tasks (no `conversations`, no `pushes`);
  - `attempts_v` = the two rollups + attempts;
  - `task_blocking_v` = attempts_v, task_dependencies, tasks.
- **Declaration (`tasks-core/core/resources.ts`).** `taskRows = liveCollection("tasks", { row: TaskListItemSchema, id: "id", all: { orderBy: [["rank","asc"],["createdAt","asc"]], unbounded }, preload: "boot" })`. `taskDescriptions = liveCollection("task-descriptions", { row: { id, description }, id: "id" })` is lookup-only, so it mints `:rows` only. `tasksResource` and `taskDetail` are deleted (core barrel, server barrel, declares, served value).
- **Serve (`server/internal/task-rows.ts`, `taskRowsServeOptions`, the one spelling the server and the tests compile).**
  - Joins:
    - `att`: children over `attempts` on `task_id`, with the conv and push rollups nested; its aggregates come from `taskAttemptAggregates`, the flags `ifNone false`.
    - `deps`: children over `task_dependencies`, giving `dependencies` via `array_agg(depends_on_task_id ORDER BY created_at)`, `ifNone ARRAY[]::text[]`.
    - `blocking`: a closure over `task_dependencies` (child `task_id`, parent `depends_on_task_id`, nodes `tasks`). Each ancestor carries its own `att` children with both rollups, and the closure aggregate is `bool_or(depIsBlocking(...))`.
  - Columns: `status` / `active` / `finishedAt` are `expr(taskDerived(j)…)`, `dependencies` is `j.deps.list`, and every other field binds by name to `tasks`. The options are typed `satisfies ServeAllCollectionOptions<typeof _tasks, TaskListItem, typeof joins>`.
  - `resources.ts`: `serveCollection(taskRows, taskRowsServeOptions)` and `serveCollection(taskDescriptions, { from: _tasks })`. The `rel(attemptsResource, …)` edge into `tasks` is gone; `attempts` keeps its own legacy edges until step 20.
- **Routed layouts after the deploy.**
  - `task_dependencies`: `live_state_notify_routed('', '["task_id"]', '[]')` on i / u / d (previously the plain `live_state_notify`).
  - `pushes` carries `attempt_id`, gated on attempt_id, created_at, id.
  - `conversations` carries `attempt_id`.
  - `tasks` gates on every column including `description` (from `task-descriptions:rows`).
- **Readers.** All 20 production `useResource(tasksResource)` sites now read `useLive(taskRows)`.
  - With a `select`:
    - `useTask(id)` (`tasks/web/client.ts`, `useCallback` on `id`);
    - task-detail's `useResolveTask` (an existence boolean);
    - worktree-identity's title, which drops its explicit `gate: true` because `useLive(all, { select })` is gated already.
  - Plain reads (the cached array is shared, so the `TaskGraph` `WeakMap` still hits across observers): `useTasksById`, `useActiveDependentCount`, task-graph, deps-tree (2), child-count, tasks-list-view, task-dependencies (2), task-draft-popover, attempt-chip, task-card, task-link-chip, the page todo task-link hook, add-task-tool-view, use-queue-rows, dependencies-button.
  - `task-description.tsx` reads `useTask(id)` plus `mapRow(useLiveRow(taskDescriptions, id), r => r?.description ?? null)`. The launch prompt seed is `fresh ?? { ...task, description }`, and the `getTask` refetch (which reads `tasks_v`) stays.
- **Lint (network/live Item 3).** The 13 `· tasks` lines are removed. `attempt-chip.tsx` and `use-worktree-identity.ts` move under `· attempts`, `use-queue-rows.ts` under `· conversations-active, conversations-gone`, and `tasks` is dropped from the two tasks-core files' comment.
- **C24 docs.** The `taskDetail` examples in `network/live/core/internal/live-value.ts` and network/live CLAUDE.md now use the real `pluginChanges` (`review.plugin-changes`, params `conversationId`).
- **C35 gate: passes, so nothing was pulled forward.**
  - Runtime `_debug` on the deploy (197 entries, after the e2e) lists no entry whose raw read-set contains `tasks_v`: `tasks` = attempts, task_dependencies, tasks; `attempts` = attempts_v, conversations_v.
  - L2 `live_state_snapshot.tables_read` has no `tasks_v` either; `tasks` = attempt_conv_agg, attempt_push_agg, attempts, task_dependencies, tasks, with a definition and `definition_at = persisted_at`.
  - Static audit of the remaining `tasks_v` readers:
    - `page/annotations/todo/task-link`'s `resolveTodoAnnotations` is reached only through `markdown-apply`'s `readPageAsMarkdown` / `readBlockAsMarkdown` / `loadBlockScope`, whose callers are MCP tools, agent-access policy, instructions delivery and todo mutations. None is a live loader.
    - `automations.catalog` (`openAutomationTaskIds`) is a `source: "external"` value, re-pushed by explicit `notify()` (including on status changes in `attention.ts`), never by feed routing.
    - The `getTask` endpoint is HTTP.
- **Tree oracle (`tasks-core/server/internal/tree-oracle.test.ts`).**
  - The REAL `taskRows` is registered beside the probe, compiled with `taskRowsServeOptions` against the throwaway. It is subscribed `{}` plus a `:rows` point reader of {T1, T3}.
  - `withSteps` splices in one `tasks`-only step, `task.describe` (a description write).
  - Every step's cost is pinned exactly, and every step converged against a fresh FULL (both views and the kept `{}` snapshot). The point reader's loads are exactly the pinned ones. There is no FULL after the subscribe, and the idle `{}` snapshot stays current through a rename, an edge insert and a delete with nobody subscribed.

  | Step | `tasks` loads (orderOf) | `:rows` {T1, T3} |
  |---|---|---|
  | task.insert | [T6] (1) | — |
  | edge.insert T6→T3 | [T6] | — |
  | task.rename | [T2] | — |
  | task.describe | [T1] (derived `updated_at`) | [T1] |
  | task.hold T3 | [T3, T6] | [T3] |
  | attempt.insert / conversation.insert / push.insert (on T3) | [T3, T6] each | [T3] |
  | conversation.done (T1 completes) | [T1, T2, T3, T4, T6] | [T1, T3] |
  | conversation.poller (`waiting_for`) | — | — |
  | task.reorder | [T5] (1) | — |
  | attempt.move T2→T4 | [T2, T3, T4, T6] | [T3] |
  | edge.delete T3→T2 | [T3, T6] | [T3] |
  | attempt.delete (A1, cascade) | [T1, T2, T4] | [T1] |
  | task.delete T2 | [T2] (see deviations) | — |
  | task.drop T4 | [T4] | — |

- **Parity (`all-parity.test.ts`).** The tasks half now compiles the SHIPPED declaration: `compileCollection(taskRows, { ...taskRowsServeOptions, db })`.
  - It is checked against `tasks_v` minus `description`, row for row, in Europe/Paris, before and after the write round.
  - The order is checked against Postgres's own `ORDER BY rank, created_at, id`.
  - Scoped(S) ≡ full ∩ S and `:rows` ≡ full ∩ S.
  - The suite installs the real rollups and views through `installTaskDerivedSchema`; its private `has_waiting_conv` rollup copy is gone. `views.test.ts` is unchanged and green.
- **C39 (old bundle).** Checked against the real `tasks` key on the oracle with `subscribeAsOldDescriptor`: `parsed` under `z.array(TaskListItemSchema.strict())` and under `z.array(TaskListItemSchema)`, equal to the kept set as it crosses the wire. The rows are byte-compatible, so the key keeps its name.
- **`tree-live-verify`.** The step-19 phase is in, and the run on deploy `6b4c1c8223-1791397243309` reports **ALL CHECKS PASSED (16)**. Each of these arrives as one scoped delta on the socket:
  - a second seeded task is one upsert (`new`);
  - a hold is one upsert (`held`), and a release one upsert (`new`);
  - an edge B→A is one upsert of B (`blocked`, `dependencies [A]`), and its removal one upsert of B (`new`, `[]`);
  - B's delete is a delete.

  Over the whole phase, no `tasks` frame re-sends the set, there is no HTTP read of `tasks` after first paint, and the page never reloads. The reload's boot snapshot carries the seeded task's row. The step-18 checks still pass.
- **W1/W2 (`get_runtime_profile kind=loader`, the same deploy, after the e2e).** `tasks` had 8 loads:
  - 2 `sub`-origin whole-set loads, one for the page's subscribe and one for the reload: 430 ms on the cold first, 137 ms on the second;
  - 6 `push` loads, avg 5 ms, max 7.7 ms, `measuresMax.ids` 1.

  Every change was a scoped load, and there was no FULL on an insert, delete, status flip or edge write. **W1/W2 hold for `tasks`.**

  Not yet fixed (later steps' scope, recorded for them): the same window shows the legacy readers still reloading on task writes. `attempts` had 6 push loads at ~157 ms; its read-set includes `conversations_v`, which reads `tasks` (step 20). `conversations-active` / `-system` / `-gone` / `-gone-stats` had 6 push loads each (W4, step 22).
- **Trigger time** (`--repeats 9`, the 16·0 pinned fixture; JSON in the session scratchpad as `trigger-time-19.json`).
  - The host was quieter than at 18: the empty-transaction COMMIT took 0.044 ms (0.036 ms at 16·0, 0.181 ms at 18).
  - Tables whose layout changed in this step:
    - `task_dependencies`, now routed: INSERT exec 0.119 ms (trigger `live_state_task_dependencies_i` 0.081 ms vs 0.053 ms at 16·0); DELETE exec 0.087 ms (trigger 0.080 ms vs 0.033 ms). That is about +0.03–0.05 ms per statement for the routed old/new rows.
    - `UPDATE tasks status` (`held_at`): exec 0.652 ms, `live_state_tasks_u` 0.542 ms (vs 0.304 / 0.32 at 16·0 / 18).
  - The rest: `INSERT attempt` 0.262; `UPDATE conversations status` 1.041 (`attempt_conv_agg__conversations_u` 0.240, which now also aggregates `has_waiting_conv`); `waiting_for` only 0.319 (both rollup triggers ≤ 0.015, so the diff still drops it); `INSERT pushes` 0.298; `UPDATE tasks_ext_category` 0.114; `DELETE attempt` (cascade) 0.815; `UPDATE attempts.task_id` 0.144. COMMIT with throwaway rows: 0.091 ms.
  - As in ★17, the script's committed throwaway delete leaves W8 drift on `task_latest_conversation` until step 21, so the next boot of this deploy will take the heal backstop.
- **Tests.**
  - `./equin test` over `plugins/tasks` (every sub-plugin), active-data attempt / task / task-link, the page todo task-link, add-task, queue, dependencies, network/live and `auto-start-launch.test.ts`: bun **632 pass / 0 fail** (62 files); vitest **52 pass** (3 files).
  - The tree oracle passed in 2 separate runs (alone, and in the run above).
- **Build:** green (`6b4c1c8223-1791397243309`, the e2e and profile deploy; final docs-only rebuild `6b4c1c8223-1791397921800`). The first build failed `plugin-boundaries` R13 (`TaskListItemSchema` public with only a test importer); see deviations.
- **Deviations.**
  - The core declaration is named `taskRows`, not `tasks`. On the server `tasks` is the `tasks_v` view handle, and the plan's `useLive(tasks[,{select}])` names the key. This follows the `pushRows` precedent. The key is still `tasks`.
  - Four builders, not three. `taskAttemptAggregates` is the per-task aggregate set both readers group, so the `bool_or` / `min` shapes are written once too. `completed` is `(CASE …) = 'completed'` over `attemptDerived`'s status, so "completed" has no second spelling. `depIsBlocking` takes `hasCompleted` as an operand: each reader supplies its own shape (an `EXISTS` over `attempts_v` in the views, the ancestor's children aggregate in the collection).
  - `tasks_v` no longer reads `attempts_v`. Its per-task CTE groups `_attempts` + rollups through the same builders as the collection, so `tasks_v`'s SQL is the collection's in view form. `task_blocking_v` still reads `attempts_v`.
  - `TaskListItemSchema` is dropped from tasks-core's CORE barrel. After the migration its only importer through the barrel was the oracle test (R13), which now imports it through the plugin's own `server/internal/schema` shim. The server barrel still exports it.
  - The tree oracle now also installs the derived `updated_at` triggers (`installDerivedUpdatedAt` over `tasksCoreDerivedUpdatedAt`), as a backend does at boot. Without them a description write cost nothing in the oracle while it costs a one-row refill in production. Nothing else in the tree workload writes a column that only moves `updated_at`, so the probe's and `task-categories`' pinned costs are unchanged (the step-18 suite passed in the same run).
  - `task.delete` costs one scoped load, `[T2]`, not none. The task's own edge is cascade-deleted in the same transaction, and its route asks for T2's refill, which reads nothing because the delete is the exit. A pending holds deletes and refills as sets with no order, so the runtime cannot drop a requested id that is also deleted (a delete followed by a re-insert of the same id must load). The cost is pinned with that reason. The step-18 probe comment "its attempts' cascade reaches a host now gone" was imprecise: T2 had no attempt left at that point.
  - Not done: a dedicated oracle for `task-descriptions:rows`. It is a plain lookup-only collection over `tasks` (network/live's generic suites cover the form). The e2e does not open a task's detail pane either, so the description editor's live read is checked only by tsc and by the build.

### 19 (review round) — a frozen C39 row, the `need_action` path, the description reader in the oracle, stale docs (2026-10-07)

- **C39 old-bundle check now pins something.** `LegacyRowsSchema` in `tree-oracle.test.ts` used to be `z.array(TaskListItemSchema.strict())`, the same live schema the declaration uses as its row, so it changed together with the row and passed whatever the row became. It is now a literal frozen copy of the row as it was at step 19, `.strict()`: id, folderId, groupId, clusterId, title, titleAuto, author, droppedAt, heldAt, rank (`RankSchema`), createdAt, updatedAt, status (the nine-value enum written out), active, finishedAt, dependencies. A field added fails the parse as an unknown key; a field removed or renamed fails it as a missing key. Either change must rename the key, which is what `core/resources.ts` says the test pins. This now matches step 18's `task-categories` case.
- **The `need_action` path is tested against the conversations.** New `views.test.ts` case: an unblocked task whose attempt has a `waiting` conversation reads `need_action` in `tasks_v`. After `UPDATE conversations SET status = 'working'` the same task reads `in_progress`, so the rollup's INSERT and UPDATE arms of `has_waiting_conv` are both exercised. Before this case, a `has_waiting_conv` that was always NULL or false would have passed every suite.
- **A step for a waiting agent that resumes.** New tasks-only oracle step `conversation.resume`, spliced after `conversation.poller`: C3 `waiting` → `working`, `waiting_for` cleared. Its pinned cost for `tasks` is `[T3, T6]` (T3 and its dependent), and `[T3]` for the `tasks:rows` point reader. The probe pays nothing. T3 is held at that point, so the status value does not move. The point of the step is the cost, and that `status` stays a routed rollup input. The value path is covered by the views case above.
- **`task-descriptions:rows` is in the tree oracle.** The harness gains `registerLookup(collection, specs)` for a lookup-only collection. It compiles the `:rows` point spec with `compileWindowQuery` (the same compile `serveCollection` hands `windowQueryResource`), counts its loads, and checks convergence like any point reader. `registerAll` now shares the `:rows` registration with it (`registerRows`).
  - The oracle subscribes `taskDescriptions` `:rows` for {T1, T2} and pins the cost of every step (`DESCRIPTIONS_COST`): `[T1]` on `task.describe` and nothing on any other step.
  - `task.rename` (T2's `title`) and `task.hold` are gated out on `description`. Attempt, conversation and push writes are on tables it does not read.
  - `task.delete` removes T2 with no load: the exit leaves the read, and convergence against a fresh FULL holds T1 alone.
  - Every load after the subscribe is one a step pinned. The step-19 deviation "no dedicated oracle case for `task-descriptions:rows`" is withdrawn.
- **Stale docs fixed.**
  - query-resource CLAUDE.md: only `conversations-active` / `-system` still use `queryResource`. The `edges:` bullet no longer cites `tasksResource`. No resource uses `queryResource({ edges })` any more, and the remaining edges are all `compileEdges` (`attemptsResource`, `agentLaunchesResource`).
  - worktree-identity CLAUDE.md now names `useLive(taskRows, { select })`.
  - The `views.ts` comment now says `tasks_v` declares `dependsOn: ["task_blocking_v"]`.
  - The `liveValue` doc example for `pluginChanges` drops `load: "on-demand"`, which the real declaration does not set.
  - The `TaskListItemSchema` comment in `core/internal/schema.ts` names `taskDescriptions` instead of the deleted `task-detail` resource.
- **Measurements.** No table layout changed in this round (tests and docs only), so the trigger-time script was not re-run. Step 19's numbers stand. The runtime W-checks are unchanged for the same reason: no served code moved.
- **Tests.** `./equin test plugins/tasks/plugins/tasks-core`: bun **123 pass / 0 fail** (13 files). This includes the tree oracle with the description reader and `conversation.resume`, the frozen C39 case, the new `views.test.ts` case, and `all-parity`.
- **Build:** green (`6b4c1c8223-1791399040261`).

### 20 — `attempts` as an `all` collection; the carrier deleted; C36 (2026-10-07)

- **Declaration (`tasks-core/core/resources.ts`).** `attemptRows = liveCollection("attempts", { row: AttemptWithConversationsSchema, id: "id", all: { orderBy: [["createdAt", "asc"]], unbounded }, preload: "boot" })`. `attemptsResource` (the `keyedResourceDescriptor`) is deleted from core, the core barrel and the server barrel. The name is `attemptRows` for the same reason as `taskRows`: `attempts` is the server's view handle.
- **Serve (`server/internal/attempt-rows.ts`, `attemptRowsServeOptions`, the one spelling the server and the tests compile).**
  - Joins: the two rollups row-wise (`conv`, `push`, `on` the base pk) and `convs`, a children join over `conversations` on `attempt_id`, `where kind <> 'system'`, aggregating `jsonAgg(id, title, status, kind, createdAt, spawnedBy; createdAt asc)`.
  - Columns: `status` / `active` / `retained` / `finishedAt` are `expr(attemptDerived(…))` over the rollup refs (the definition `attempts_v` interpolates); `conversations` is `j.convs.list`; the rest bind by name to `attempts`.
  - `resources.ts`: `serveCollection(attemptRows, attemptRowsServeOptions)`; the hand-written loader, its `rel()` edges and `compileEdges` are gone.
- **C1 fixed by construction.** The conversations route gate is the children route's (`attempt_id`, `id`, `kind`, `title`, `status`, `created_at`, `spawned_by`) plus the conv rollup source's (`attempt_id`, `id`, `status`, `ended_at`), so `waiting_for` / `last_viewed_at` / `updated_at` reach nothing. A push reaches its attempt through `attempt_push_agg`'s source route. Deleted: `pushesAttemptsCascade` and its declare, `listPushes` (and its barrel line), `listConversationSummariesByAttempt`, the `attemptsResource` server export. `conversationCascadeSignatures` / `TRANSIENT_CONVERSATION_FIELDS` stay for the agents `rel()` until step 21 (C28); their comment now names only that edge.
- **C36.** New `getAttemptRow(id)` over `_attempts` (server barrel). commits-graph's `worktreeFor` and attempt-work's `readContext` read it. Beyond C36, `listConversationIdsForAttempt` (attempt-work's other DB read) now reads `_conversations` instead of `conversations_v` (same set: NOT NULL FK, inner join), so attempt-work's read-set is `attempts`, `conversations`, `pushes` and no task write recomputes it (git work).
- **Readers.** All moved to `useLive(attemptRows[, { select }])`: `attempt-pane.tsx` (2), `attempt-switch-button.tsx`, attempt-view `panes.tsx`, `tasks-core/web/hooks.ts` (`useTaskAttempts`, `useTaskConversations`, both `select`), `use-worktree-identity.ts` (`select`; its explicit `gate: true` dropped, `useLive(all, { select })` is gated), `attempt-chip.tsx`. Comments updated in `conversation-item.tsx`, `conversation-row.tsx`, `conversation-chip.tsx` and the chip / worktree-identity CLAUDE.md files.
- **Lint (network/live Item 3).** The six `· attempts` lines are removed. `tasks-core/core/resources.ts` and `server/internal/resources.ts` remain, now under `· conversations-active, conversations-gone, conversations-system`.
- **Deployed layouts** (build `6b4c1c8223-1791401647971`): `attempts` `live_state_notify_routed('id', '["task_id"]', '["id","task_id","worktree_path"]')`; `conversations` carries `attempt_id` with columns `attempt_id, created_at, ended_at, id, kind, model, runtime, spawned_by, status, title, updated_at` (no `waiting_for`, no `last_viewed_at`); `pushes` carries `attempt_id`, columns `attempt_id, created_at, id`. L2: `attempts` has a definition, `definition_at = persisted_at`, `tables_read = {attempt_conv_agg, attempt_push_agg, attempts, conversations}` (2.6 MB); no `pushes.attempts-cascade` row.
- **Tree oracle (`tree-oracle.test.ts`).** The REAL `attemptRows` (compiled with `attemptRowsServeOptions`) is registered and persisted beside `tasks`, subscribed `{}` plus a `:rows` reader of {A2, A3} (A3 inserted mid-script). Two steps spliced after `push.insert`: `conversation.retitle` (C3's title) and `conversation.system` (a `system` conversation on A3). Every step's cost pinned and converged against a fresh FULL; no FULL after the subscribe; the point reader's loads are exactly the pinned ones; the idle `{}` snapshot stays current (an `idle.attempt` insert, then T3's delete cascading A3).

  | Step | `attempts` loads (orderOf) | `:rows` {A2, A3} | `tasks` |
  |---|---|---|---|
  | attempt.insert A3 | [A3] (1) | [A3] | [T3, T6] |
  | conversation.insert / .resume / push.insert / .retitle / .system (on A3) | [A3] each | [A3] | [T3, T6] each, except retitle: — |
  | conversation.done (C1, A1) | [A1] | — | (step 19) |
  | conversation.poller (`waiting_for`, `last_viewed_at`) | — | — | — |
  | attempt.move A2 T2→T4 | [A2] | [A2] | (step 19) |
  | attempt.delete A1 (cascade) | [A1] (an exit plus its cascaded conversation / push routes; reads nothing, as `tasks`' `task.delete`) | — | (step 19) |
  | every task / edge write, task.reorder | — | — | — |

  All costs matched on the first run.
- **Parity (`all-parity.test.ts`).** The attempts half now compiles the SHIPPED declaration (`compileCollection(attemptRows, { ...attemptRowsServeOptions, db })`) against `attempts_v` in Europe/Paris, before and after the write round; its hand-written copy of the joins is gone.
- **C39 (old bundle).** `subscribeAsOldDescriptor` against the real `attempts` on the oracle: `parsed` under a literal frozen copy of the step-20 row (`.strict()` at the row and at each listed conversation) and under `z.array(AttemptWithConversationsSchema)`, equal to the kept set over the wire (which has listed conversations). Byte-compatible, so the key keeps its name. The legacy wire had `createdAt` as `Date.toJSON()`; `jsonAgg` renders the same ISO-8601 `Z` text.
- **`tree-live-verify`.** The step-20 phase is in. The page is now the seeded task's detail pane (`/agents/tasks/t/<id>`), whose attempt sections read the set. Run on this deploy: **ALL CHECKS PASSED (25)**. An attempt arrives as an entrant (`pending`, no conversations) and the task as one upsert (`in_progress`); a `done` conversation as one upsert of the attempt (`closed`, listed); a `last_viewed_at` write produces no `attempts` frame (the next one is the retitle that follows it); a push is one upsert of the attempt (`completed`) and of the task (`done`); the attempt's delete is a delete and the task one upsert (`new`). No `attempts` frame re-sent the set, no HTTP read of a tree key after first paint, no reload. The step-18/19 checks still pass. Noise: two gateway `429`s.
- **W3 (`get_runtime_profile kind=loader`, same deploy, after two e2e runs).** `attempts`: 14 loads, 4 `sub` (the subscribe and the reload of each run; 450–1230 ms on a contended host) and 10 `push`, avg 14 ms, max 41 ms, `measuresMax.ids` 1. `tasks`: 20 `push` loads, avg 32 ms, `measuresMax.ids` 1. **A push ⇒ 0 FULL on `attempts` and `tasks`; `pushes.attempts-cascade` no longer exists. W1/W2 hold for `attempts`.** Still open (step 22, W4): `conversations-active` had 21 push loads over the same window.
- **Trigger time** (`--repeats 9`, the 16·0 pinned fixture; JSON in the session scratchpad as `trigger-time-20.json`; empty COMMIT 0.046 ms, so a quiet host like step 19's). Tables whose layout changed: `INSERT attempt` exec 0.198 ms (`live_state_attempts_i` 0.132); `UPDATE attempts.task_id` 0.175 (`_u` 0.151); `UPDATE conversations status` 1.070 (`live_state_conversations_u` 0.356, `task_latest_conversation` 0.313, `attempt_conv_agg` 0.222); `waiting_for` only 0.349 (both rollups ≤ 0.016); `INSERT pushes` 0.358 (`live_state_pushes_i` 0.131, `attempt_push_agg` 0.120); `DELETE attempt` (cascade) 0.994. The rest: `UPDATE tasks status` 0.634; `task_dependencies` INSERT 0.141 / DELETE 0.105; `tasks_ext_category` 0.213. COMMIT with throwaway rows 0.213 ms. All within step 19's range. As before, the script's committed throwaway delete leaves W8 drift on `task_latest_conversation` until step 21.
- **Tests.** `./equin test` over tasks-core, network/live, attempt-view, worktree-identity, attempt-work, task-events, active-data/attempt, commits-graph and conversation-ui: bun **559 pass / 0 fail** (54 files); vitest **52 pass** (3 files). tasks-core alone: 124 / 0 (13 files).
- **Build:** green (`6b4c1c8223-1791401647971`). The first build failed `plugin-boundaries` R13 (`AttemptWithConversationsSchema` public in core with only the oracle test importing it): it is dropped from the core barrel and the test imports `core/schemas` by relative path. The e2e's task-status expectation was corrected after that build (string and comment only).
- **Deviations.**
  - **`jsonAgg` typing (network/live `serve-all.ts`).** An aggregate binding may now hold the field's JSON FORM (`JsonForm<V>`: a `Date` as its ISO string, recursively) as well as `V`. `jsonAgg` returns its elements as the JSON the driver parsed (a `timestamptz` as the compiler's ISO text), which is byte for byte what the wire makes of the decoded value; requiring `V` would have meant decoding every element only to re-encode it. Step 20 is the first `serveCollection` with a `jsonAgg`; the client parses `conversations[].createdAt` with the row schema as before. network/live CLAUDE.md (*The `all` arm*) states it.
  - `listConversationIdsForAttempt` re-pointed at `_conversations` (beyond C36's two named sites; same rationale).
  - The first e2e run expected the entrant to move the task to `attempted` (the script's own wrong expectation); a pending attempt (no conversation) is `active` in `attemptDerived`, so the task reads `in_progress`. The check was corrected; no served code changed.
  - Docs: `docs/tasks-model.md` *Cascade* rewritten for the two routed sets (the legacy DAG diagram is gone); tasks-core CLAUDE.md *Live resources* gains `attemptRows` and the C36 rule; query-resource CLAUDE.md names `agentLaunchesResource` as the last `compileEdges` user; register.ts, the `pushRows` comment and `queries/pushes.ts` no longer mention the carrier; attempt-work's `resource.ts` comment likewise.

### 20 (review round) — the JSON form for a `jsonAgg` only; the e2e claims only what frames show (2026-10-07)

- **The JSON form is a `jsonAgg`'s alone (rung 2).** Step 20's `AllFieldBinding` accepted `AggregateRef<…, JsonForm<V>>` for every aggregate, so a scalar `aggregate(sql\`max(x.ended_at)\`, { decoder: String, sqlType: "timestamp with time zone" })` bound to a `Date` field type-checked although it ships Postgres's text form (`2026-10-07 12:00:00.123+00`), not ISO. Now `Aggregate<V, F>` and `AggregateRef<R, N, V, F>` carry a type-only FORM phantom (`AggregateForm = "decoded" | "json"`, default the union, so every existing three-argument spelling still reads both): `aggregate` returns form `decoded`, `jsonAgg` form `json`, and `AggregateRefsOf` hands each ref its aggregate's form (`AggregateFormOf`). `serve-all`'s binding is `AggregateRef<…, V, "decoded"> | AggregateRef<…, JsonForm<V>, "json">`. Pinned in `serve-collection-all.test.ts` (types): a `jsonAgg` of a `timestamptz` binds a `{ at: Date }[]` field; a scalar `string` aggregate bound to a `Date` field is a `@ts-expect-error`. query-resource and network/live CLAUDE.md state it. No runtime or wire change (`AggregateForm` is not exported: nothing outside `all-joins.ts` names it).
- **The e2e no longer claims the viewed-at cost.** The step-20 check "a viewed-at write reaches no `attempts` frame" could not fail on the regression it named: the runtime diffs a refill against the kept rows and sends no frame for an identical row, so a `last_viewed_at` write routed into `attempts` again (C1) would refill, send nothing, and pass. The `last_viewed_at` write is dropped from the e2e; the check is now "a retitle arrives as one upsert of its attempt, carrying the new title", and the script's header says the poller write's cost is NOT checked on the socket. Its evidence is the tree oracle, which counts loads: `conversation.poller` (`waiting_for` + `last_viewed_at` on C3, A3's conversation) is pinned at no load and no `orderOf` on `attempts`, `attempts:rows` and `tasks`. The step-20 bullet above (*`tree-live-verify`* — "a `last_viewed_at` write produces no `attempts` frame") overstated it: read it as the retitle check only.
- **Rejected alternative:** reading `attempts` loader spans with `parent.kind === "push"` from the e2e. The runtime profile is served only through debug/profiling's plugin-private endpoint (`shared/`), which an `e2e/` script may not import, and a hard-coded path would drift silently; the oracle already pins the exact cost.
- **Verification.** Build `6b4c1c8223-1791404242411` green (type-check included — the new `@ts-expect-error` is live). `./equin test` over network/live, query-resource and tasks-core: bun 679 pass, 0 fail; vitest 52 pass. `tree-live-verify`: **ALL CHECKS PASSED (25)**. No layout changed, so the 16·0 trigger-time numbers of step 20 stand.

### 21 — `agent-launches` as an `all` collection, atomic with `task_latest_conversation`'s `attempts` source (2026-10-08)

- **The rollup's second source (C1, W8, A35)** — `agents/server/internal/rollup-spec.ts`.
  - `task_latest_conversation` gains `{ table: attempts, carry: attempts.task_id, reads: [], ops: ["update", "delete"] }`. `defineRollup` generates `task_latest_conversation__attempts_{u,d}`: `AFTER UPDATE` with no column list (C1), whose maintain diffs `old_rows FULL JOIN new_rows ON id` over `(task_id)`.
  - `reads` is empty: `id`, the hop's `match`, is the primary key, so a re-keyed row is seen unmatched on both sides.
  - Insert is not an op: a new attempt has no conversation yet.
  - Old and new task ids both come from the transition tables, so an attempt delete (its conversations cascade and resolve no task through the hop), an attempt move, and a task delete (attempts cascade) all re-aggregate the right task.
  - The rollup is now two-source, so query-resource's A35 (`assertHopsCovered`) accepts a reader joining it.
- **C27 wire** (`agents/server/internal/agent-launch-rows.ts`, `agentLaunchRowsServeOptions`, the one spelling the server and the oracle compile).
  - Shape: `agent_launches` with one top-level rollup join, `latest`, on `base.task_id`. The task id is not the launch key, so every route into it is a reverse onto `agent_launches.task_id`.
  - The rollup's read handle declares `status` as `parsedText("status", ConversationStatusSchema)`. The DDL is still `text`, so the DDL signature is unchanged and nothing reinstalled.
  - `latestConversationStatus` is `j.latest.status`, nullable through the LEFT join.
  - `latestConversation` is `expr(CASE WHEN latest.task_id IS NULL THEN NULL ELSE json_build_object('id', …, 'title', …, 'status', …) END, { decoder: nullable(parsed(AgentLaunchConversationRefSchema, …)), sqlType: "json" })`.
  - `AgentLaunchConversationRefSchema` and its type moved to `agents/core/schemas.ts` (not exported from the barrel).
- **Declaration** (`agents/shared/resources.ts`): `agentLaunchRows = liveCollection("agent-launches", { row: AgentLaunchWithStatusSchema, id: "id", all: { orderBy: [["createdAt", "asc"]], unbounded }, preload: "boot" })`, plugin-private like `task-categories`.
  - Served as `serveCollection(agentLaunchRows, agentLaunchRowsServeOptions)` and contributed as `...agentLaunchRowsServed.declare` (`agent-launches` and `agent-launches:rows`).
  - The legacy `keyedResourceDescriptor`, the `defineResource` with `identityTable` / `fanOut` / `compileEdges([rel(conversationsActive …)])`, and its hand-written loader are deleted. The web barrel (`:27`) and server barrel (`:42`) re-exports are gone; nothing outside agents imported them.
- **Readers.** All five components now read `useLive(agentLaunchRows)` (plain reads, the cached array shared): `agent-status`, `agent-avatar-row`, `agent-avatar-title-prefix`, `agent-detail` (through `foldResource`), and `agent-launches`.
- **C28 deletions** (tasks-core):
  - `conversationCascadeSignatures`, `TRANSIENT_CONVERSATION_FIELDS` and their barrel line;
  - the `conversationsView` server export.

  Stale comments were also updated: `resources.ts` (the agent-launches cascade note), `attempt-rows.ts`, `listConversationsForDisplay`'s doc, and the page task-link CLAUDE.md.
- **D30:** `handle-list-launches.ts` keeps its hand-written form, with a comment naming the duplicate. Follow-up filed as sidequest `task-1791410472829-1ybi11`.
- **Lint (network/live Item 3):** the seven agents entries (`· agent-launches`, and `· agent-launches, conversations-active` for `server/internal/resources.ts`) are removed.
- **Deployed layouts** (build `6b4c1c8223-1791409226480`):
  - `agent_launches` triggers are routed: `live_state_notify_routed('id', '[]', '[]')`, where it was plain before.
  - `attempts` carries `task_id`, as at step 20, plus the new `task_latest_conversation__attempts_{u,d}`.
  - L2: `agent-launches` has a definition, `definition_at = persisted_at`, and `tables_read = {agent_launches, task_latest_conversation}`.
  - The first boot installed the two attempts triggers. It also healed one stale rollup row (`+0 −1`), the W8 leftover of step 20's committed trigger-time delete. The second backend of the hot swap found no drift.
  - After the step-21 trigger-time run (which commits a throwaway attempt delete), the rollup equals its aggregate (4,567 rows; 0 missing, 0 extra). That committed delete no longer leaves drift, so the next boot's A20 heal backstop is gone.
- **Tree oracle.**
  - The harness gains `TreeOracleOptions.rollups`: a downstream owner's rollups, installed together with tasks-core's own through `installRollups` (the boot path) and made feed-exempt like them.
  - Agents' suite is `agents/server/internal/agent-launches-oracle.test.ts`. agents is downstream of tasks-core (R6), so it runs in the owner, like step 18's.
  - It registers the REAL compiled `agentLaunchRows` with the REAL `taskLatestConversation` installed. It subscribes `{}` and a `:rows` reader of {L1, L2}, and seeds an agent with five launches (two on T1).
  - After every step it requires `taskLatestConversation.driftSql` to find no key. That is the W8 check against the shipped declaration; the tree oracle's FULL reads the rollup, so it alone could not see a stale rollup. Every view and the kept snapshot must also converge to a fresh FULL.
  - Spliced steps:
    - `launch.insert` (L6 on T6);
    - `conversation.retitle` (C3);
    - `attempt.older` (one statement inserting A4 on T1 with C4 a day older than C1);
    - `launch.delete` (L3).
  - Pinned costs (all matched on the first run):

  | Step | `agent-launches` loads (orderOf) | `:rows` {L1, L2} |
  |---|---|---|
  | launch.insert | [L6] (1) | — |
  | attempt.insert A3 (T3) | [L3] (see deviations) | — |
  | conversation.insert C3 / conversation.retitle | [L3] each | — |
  | conversation.done C1 (T1) | [L1, L5] | [L1] |
  | conversation.poller (`waiting_for`, `last_viewed_at`) | — | — |
  | attempt.move A2 T2→T4 | [L2, L4] | [L2] |
  | attempt.older (A4 + C4 on T1) | [L1, L5] | [L1] |
  | attempt.delete A1 (cascade) | [L1, L5] | [L1] |
  | launch.delete | — (exit) | — |
  | every task / edge / push write, task.reorder, task.delete T2, task.drop | — | — |

  - **W8 assertions on the kept set.**
    - After `attempt.delete`, both T1 launches carry C4 (`done`): the fallback to the older conversation.
    - After `attempt.move`, L2 has none and L4 has C2.
  - Nothing loads FULL after the subscribe, and the point reader's loads are exactly the pinned ones.
  - With no subscriber, a conversation close and a launch insert keep the kept `{}` current.
  - **C39:** `subscribeAsOldDescriptor` against the real key gets `parsed` under a literal frozen, `.strict()` (row and nested ref) copy of the step-21 legacy row, and under `z.array(AgentLaunchWithStatusSchema)`. Both equal the kept set, the rows are byte-compatible, and the key keeps its name.
- **`tree-live-verify`: step-21 phase.**
  - It runs on a page of its own at the seeded agent's detail pane (`/agents/agents/ag/<agent>`), whose status dot and Attempts list read the set while open.
  - The first attempt ran on the task pane and lost the subscription. That page reads launches only through a conversation item's agent avatar, which unmounted with the attempts phase's conversation, so after keep-alive no frame (not even a delete) reached it.
  - Each check:
    - a launch arrives as an entrant with `null` latest conversation;
    - an attempt and a `working` conversation, inserted in one statement, arrive as one upsert carrying it;
    - the close arrives as one upsert (`done`);
    - the attempt's delete arrives as one upsert back to `null` (W8, live);
    - the launch's delete arrives as a delete.
  - Over the phase there is no whole-set re-send and no HTTP read of `agent-launches`.
  - Agents are seeded with the `e2e-tree-` prefix and swept.
  - Result: **ALL CHECKS PASSED (32)**. Noise: gateway `429`s.
- **W-checks** (`get_runtime_profile kind=loader`, after the e2e runs on `6b4c1c8223-1791409226480`):
  - `agent-launches`: 13 loads. 12 `push` loads, avg 4 ms, max 11.8 ms, `measuresMax.ids` 1. 1 `sub` load of 2 ms over the whole 29-row set. No FULL on a change. Before this step the key was a persisted non-membership entry and reloaded FULL on every routed change (W1/W2). **W1/W2 hold for `agent-launches`.**
  - Unchanged from step 20: `attempts` had 28 push loads (avg 7 ms, max 21 ms), `tasks` 43 (avg 4 ms), `task-categories` 12 (avg 4 ms), all scoped.
  - **W8** holds three ways: the oracle's drift check after every step, the deploy's rollup equal to its aggregate after a committed attempt delete, and the e2e's live W8 check.
- **Trigger time** (`--repeats 9`, the 16·0 pinned fixture; JSON in the session scratchpad as `trigger-time-21.json`).
  - The host was contended: the empty COMMIT took 0.130 ms (0.046 ms at step 20), and tables whose layout did not change ran about 1.3–4× slower (`UPDATE tasks status` 0.634 → 0.839 ms; `DELETE task_dependencies` 0.105 → 0.423 ms).
  - Only `attempts` changed layout:
    - `UPDATE attempts.task_id`: exec 0.497 ms. `task_latest_conversation__attempts_u` 0.224 ms, the new trigger, ran beside `live_state_attempts_u` 0.239 ms.
    - `DELETE attempt` (cascade): exec 3.310 ms. `task_latest_conversation__attempts_d` took 0.474 ms. In this run's noise it is the largest single trigger, roughly what `live_state_attempts_d` costs (0.382 ms). The conversations-source `_d` fell to 0.078 ms (the hop resolves nothing).
    - `INSERT attempt`: 0.674 ms. No new trigger fires on insert.
  - The rest: `UPDATE conversations status` 2.067 ms; `waiting_for` only 1.123 ms (both rollup triggers ≤ 0.072 ms, so the diff still drops it); `INSERT pushes` 1.071 ms; `task_dependencies` INSERT 0.593 / DELETE 0.423 ms; `tasks_ext_category` 0.484 ms. COMMIT with throwaway rows: 0.330 ms.
  - Net of the host noise, the attempts source adds about one rollup maintain (≈0.1–0.2 ms on a quiet host) to an attempt update or delete. Both are rare statements.
- **Tests.**
  - `./equin test` over agents, tasks-core, task-category, network/live, migrations, derived-tables and query-resource: bun **910 pass / 1 fail** (85 files); vitest **3 files pass**.
  - The one failure is a 5 s timeout in `migrations/core/internal/published.test.ts` (a git spawn SIGTERMed under host duress), a file this step does not touch. Rerun alone, migrations is **206 pass / 0 fail**.
  - The agents oracle: 3 pass on its own and in the full run.
- **Build:** green (`6b4c1c8223-1791409226480`, the deploy measured above; final rebuild after the e2e edit `6b4c1c8223-1791410707988`).
  - The first build failed on two checks: an unused binding in the new test, and `table-defs-in-schema-glob`.
  - That check is line-based: it exempts an imperative-table read handle only when `pgTable(<CONST>` is on one line. Touching `rollup-table.ts` brought it into the formatter's allowlist, and prettier wrapped the call.
  - Fixed by renaming the handle `_task_latest_conversation` → `_latest_conversation` so the call fits on one line, with a comment naming the coupling. The check's line-based reading is filed as sidequest `task-1791410473141-8au397`.
- **Deviations.**
  - **An attempt INSERT refills the launches of its task** (one scoped load, reading an unchanged row; the runtime sends no frame for it). The rollup's attempts *trigger* fires on update and delete only, but the *route* compiled from the same source does not read `ops`, so the change feed still routes attempt inserts on `attempts.task_id`. Pinned in the oracle as `attempt.insert: [L3]`. A route honouring the source's `ops` would remove it; that is a small query-resource change left out of this step, and its cost is one point refill per attempt creation.
  - The rollup's `status` is decoded at the column (`parsedText`) instead of by an expression decoder, so `latestConversationStatus` binds as a plain column ref.
  - The tree-oracle harness gained a `rollups` option. The plan named no harness change, but agents' rollup cannot be imported from tasks-core.
  - The read handle was renamed `_latest_conversation` for the line-based check (see Build).
  - A35's `assertHopsCovered` stays at compile. Its 16b.4 note suggested moving it into `defineRollup` once this rollup is two-source. Moving it would refuse the deliberately single-source fixtures that query-resource's A35 tests build, and it is not on step 21's list.
  - Docs:
    - agents CLAUDE.md gains *Launches are an `all` collection over a rollup*;
    - derived-tables CLAUDE.md (the hop paragraph) and query-resource CLAUDE.md now say no resource uses `rel()` / `compileEdges` any more;
    - the tree-oracle harness and tasks-core oracle headers now name step 21's suite.

### 21 (review round) — the dead resource exports; the rollup route's `ops` deferred (2026-10-08)

- **Dead exports deleted (C28).** The tasks-core server barrel no longer re-exports `conversationsActiveResource` / `conversationsSystemResource` / `conversationsGoneResource`. Step 21's removal of the agents `rel()` took the last importer through `@plugins/tasks/plugins/tasks-core/server`. No file importing that barrel, test files included, names any of the three. Every web reader takes them from tasks-core/core. The `Resource.Declare` contributions keep the internal import. The build regenerated the autogen.
- **The route honouring the source's `ops` is deferred, not landed.** It cannot be fixed in query-resource alone. A rollup source's route is an `alias` or a `reverse` map, and neither sees the change's op. Skipping an op needs a gate on `Route` in resource-runtime's `routeTuple`, which is `plugins/framework/`, and framework changes need the user's approval in the conversation.
  - A prototype was written: `Route.inertOps?: ("I" | "D")[]`, derived in `rollupSourceRoute` from the ops `src.ops` leaves out, with tests. It was reverted before the build, so the tree is unchanged.
  - The prototype fixed one design point. Only `I` and `D` can soundly be skipped by op. A `U` is the feed's catch-all, used by the reconnect sweep (`ids: null`), a change producer's coalesced upsert (which includes inserts) and the view fan-out, so a source with `ops: ["insert"]` could never skip a `U`.
  - Filed as sidequest `task-1791411816223-6tbpyf`. The oracle pin `attempt.insert: [L3]` is unchanged, and its comment now names the task as the change that turns it into NOTHING.
- **Verification.** Build `6b4c1c8223-1791411975973` is green; it waited about 25 minutes for a host CPU grant under duress. `./equin test` over tasks-core, agents and query-resource: bun **288 pass / 0 fail** (28 files); vitest has no suites under these paths. No table layout changed, so step 21's trigger-time numbers stand.

### 22 — the conversation lists: `conversations-active` / `-system` as `all`, `-gone` a window, `conversations.by-id` (2026-10-08)

- **Declarations** (`tasks-core/core/resources.ts`; the barrel exports `conversationsActive`, `conversationsSystem`, `conversationsGone`, `conversationsById`, which replace the `*Resource` descriptors):
  - `conversationsActive = liveCollection("conversations-active", { row: ConversationSchema, id: "id", all: { orderBy: [["createdAt", "desc"]], unbounded }, preload: "boot" })`; `conversationsSystem` is the same over `conversations-system`. Both keep their legacy keys (C39, below).
  - `conversationsGone = liveCollection("conversations-gone", { row: ConversationSchema, id: "id", filterable: {}, sortable: ["endedAt"], default: { orderBy: [["endedAt", "desc"]], limit: RECENT_GONE_LIMIT }, maxLimit: 100, preload: "boot" })`: a window, so it leaves L2. On the deploy, `live_state_snapshot` holds no `conversations-gone` row.
  - `conversationsById = liveCollection("conversations.by-id", { row: ConversationSchema, id: "id" })`: lookup-only (D17), so it mints `:rows` alone, with the full row.
- **Serve** (`server/internal/conversation-rows.ts`, the one spelling the server and the tests compile): every collection reads `_conversations` + `conversationOwnerJoins` (two required INNER lookups, C5) and binds `conversationOwnerColumns`. `active` is `expr(status <> 'done', Boolean)`; its override is typed over `{ base: { status: unknown } }`, so the window, lookup and `all` forms share it.
  - The `where` clauses: active `status <> 'done' AND kind <> 'system'`; system `kind = 'system' AND status <> 'done'`; gone `status = 'done' AND ended_at IS NOT NULL AND kind <> 'system'`; by-id has none.
  - `resources.ts` serves all four with `serveCollection`. The `queryResource` pair, its `debounceMs: 250` (D16: dropped, no `throttleMs` either) and the gone `defineResource` (`recompute: full`) are deleted, along with the three `Resource.Declare`s; the barrel spreads the four `declare`s instead.
- **`conversationsGoneStats` re-pointed:** `countGoneConversations` counts `_conversations` (`kind <> 'system' AND status = 'done' AND ended_at IS NOT NULL`, the same set as before). L2 `tables_read` is now `{conversations}` (was `conversations_v`), so a task or attempt write no longer recounts it.
- **Readers (all 18 sites of C26, plus the by-id callers):**
  - `use-conversations.ts`:
    - `useConversation(id)` is `mapRow(useLiveRow(conversationsById, id))`; `resolveConversation` is deleted.
    - `useConversationById` folds the same row read to `row | null`. Its `useQuery` REST fallback, the `held` in-transit state and the `getConversation` / `fetchEndpoint` imports are gone. A close no longer moves the row between two lists, so there is no transit gap to cover.
    - `useHasActiveSiblings`, `useHasActiveSiblingInWorktree` and `useActiveConversations` are `useLive(conversationsActive[, { select }])`; the gate is inherent to an `all` select read.
    - `useConversationTitleBySlug` uses `select` on the two sets and maps the gone window's rows in a memo.
    - `useConversations` reads active + the gone window + stats. `ConversationsData` loses `system` and `hasMoreGone`, which nothing read.
  - conversation-view `panes.tsx`: `useResolveConversation` is `resolveRow(useLiveRow(conversationsById, convId))`; the three-list scan and the REST existence probe are deleted.
  - `use-queue-rows.ts`: `useLive(conversationsActive)` + `useLive(conversationsGone)` (the default window); `classifyQueue` is unchanged.
  - `recovery-view.tsx` (C25): `useLive(conversationsGone, { limit: 50 })`, folded with `foldResource` (loading / error with stale / ready). The `useQuery` REST page and the invalidate-on-live-change hack are deleted; the window is already `endedAt` desc, so the client sort is gone.
  - `welcome-view.tsx` needed no change: it reads `active`, `recentGone` and `totalGoneCount`, which `ConversationsData` still carries.
  - The agent-page creator chip now reads `useConversation`: loading → shimmer, error → inline Retry, absent → no chip. The "deleted creator keeps the shimmer" gap is gone, and its CLAUDE.md says so.
  - Comments updated: conversation-row (`ConversationRowById`), prompt-template chips, push-and-exit, the authorship and active-data/conv CLAUDE.md files.
- **D27 not taken: `GET /api/conversations/:id` stays.** `rg` finds another caller, the rewind e2e (`conversation-view/plugins/rewind/e2e/rewind.ts:75,127,204` reads `status` and `claudeSessionId`). The app itself no longer calls it.
  - `GET /api/conversations/gone` (`listGoneConversations`) is also left in place, though Recovery was its last in-app reader. Neither C25 nor D27 names it.
- **Lint (network/live Item 3):** the six `· conversations-*` lines are deleted. The burndown group (b) is now empty, and its comment says so.
- **C39 (old bundle):**
  - `conversations-active` / `-system`: `subscribeAsOldDescriptor` against the real keys on the oracle gets `parsed` under a literal frozen copy of the step-21 `conversations_v` row, `.strict()` (all 20 fields), and under `z.array(ConversationSchema)`. Both equal the kept set, and both sets are non-empty when checked. The rows are byte-compatible, so the keys keep their names.
  - `conversations-gone`: an old tab's param-less `{}` subscription on the new window is `refused`, `contract-mismatch`, verdict `skew` (`params.limit must be a canonical positive-integer string`), so it reloads and never misreads rows.
- **Parity (`all-parity.test.ts`):** the active half now compiles the SHIPPED `conversationsActive` (`compileCollection(conversationsActive, { ...conversationsActiveServeOptions, db })`). It is held against `conversations_v` filtered the same way, row for row in Europe/Paris, before and after the write round, with order `createdAt desc, id asc` and the owner joins' reverse probes. The test's private `contractsOf` / `compileAllCollection` copy is gone.
- **Tree oracle (`tree-oracle.test.ts`):**
  - The harness gains `registerWindow(collection, specs)` (a window and its `:rows`, loads counted, truth a fresh FULL of the tuple's params).
  - The four collections are registered with their shipped options; active and system are persisted.
  - Subscriptions: active `{}`, system `{}`, gone at its `defaultParams`, and a by-id `:rows` reader of {C1, C2}. C2 is done from the seed, so it is the W9 case: a point read finds it whatever its age.
  - One spliced step: `task.rename-live` (T3, which owns the live C3 and the system C4). Its `tasks` / probe costs are pinned too: `[T3]`, `rowLoads [T3]`; probe `[T3]` + 1 `orderOf`.
  - Every step converged against a fresh FULL, and no FULL loads after the subscribe on any of the four keys. Costs, compared as one list (any step not listed loads nothing):

  | Step | active (orderOf) | system (orderOf) | gone window | by-id {C1, C2} |
  |---|---|---|---|---|
  | task.rename (T2, title — value role) | — | — | [C2] | [C2] |
  | conversation.insert C3 | [C3] (1) | [C3] | [C3] | — |
  | conversation.done C1 | [C1] (exit) | [C1] | [C1] (entrant) | [C1] |
  | conversation.poller C3 (`waiting_for`, `last_viewed_at`) | [C3] (the one-row refill) | — | — | — |
  | conversation.resume C3 (`status`) | [C3] | [C3] | [C3] | — |
  | conversation.retitle C3 | [C3] | — | — | — |
  | conversation.system C4 | [C4] | [C4] (1) | [C4] | — |
  | task.rename-live T3 | [C3] | [C4] | — | — |
  | attempt.move A2 (`task_id` keys the required `task` lookup — membership) | [C2] | [C2] | [C2] | [C2] |
  | **W4:** task.insert / hold / describe / reorder / delete / drop, edges, attempt.insert, push.insert | — | — | — | — |
  | attempt.delete A1 (cascades C1) | — | — | — (exit) | — (exit) |

  - The idle test also runs `idle.conversations` (a live and a system conversation on `tree-a4`) and `idle.poller`. With active and system unsubscribed, their kept `{}` snapshots stay equal to a fresh FULL through those and T3's cascade delete, with no FULL load.
- **`tree-live-verify`: step-22 phase.** It runs on a page of its own at `/agents/c/<old>`, where `<old>` is a done conversation seeded with `created_at` / `ended_at` in 2020. The script first asserts that at least 30 ended conversations are newer.
  - W9: the pane resolves (its title paints) with no `GET /api/conversations/<old>`. The pane's `POST …/viewed` write is not a read and is not counted; the first run counted it and was narrowed.
  - With `conversations.by-id:rows`, `conversations-active` and the gone window live on the socket:
    - a `working` insert arrives as an entrant of active (`taskTitle` set);
    - `waiting_for` arrives as one upsert carrying it;
    - a task rename arrives as one upsert carrying `taskTitle`;
    - a close arrives as a delete from active plus an entrant of the gone window;
    - a delete arrives as a delete from the window.
  - Over the phase, no active frame re-sent the set and no HTTP read of a list or of by-id happened.
  - Run on deploy `6b4c1c8223-1791417019579`: **ALL CHECKS PASSED (43)**. Noise: gateway `429`s, one aborted `task-source-url` read on navigation, and the post-reload screenshot timing out.
- **W4 (`get_runtime_profile kind=loader`, same deploy).** Loader counts were snapshotted before and after a scripted probe: a temporary `./equin run` script, deleted after use, that ran 5 × (task hold, release, attempt insert, attempt `worktree_path` update, attempt delete) plus a task insert and delete, through the deploy DB.
  - `tasks` went from 41 to 62 push loads and `attempts` from 29 to 39 (the writes were routed).
  - `conversations-active` stayed at 19, `-system` at 15, `-gone` at 22, `conversations.by-id:rows` at 14, `conversations-gone-stats` at 27. **0 loader spans on the conversation lists for task and attempt writes. W4 holds.**
  - Over the e2e window: `conversations-active` had 19 push loads, avg 7 ms, max 17 ms; `-system` 15 (avg 9 ms); `-gone` 22 (avg 6 ms, `measuresMax.ids` 1).
  - `conversations.by-id:rows` had 496 `sub` loads (avg 3 ms). That is one per id a page mounts: the sidebar's per-conversation reads, the same count as the existing `conversation-preprompts:rows` / `conversation-progress:rows` point reads.
- **W9 holds:** the e2e above, and the oracle's by-id reader holding the done C2.
- **Layouts:** the deployed `live_state_*` triggers on `conversations`, `attempts` and `tasks` are byte-identical to step 21's. The conversation lists' identity routes need no carry, and the owner joins' reverse routes were already installed by `conversations.all` / `.history` at P7. No table's trigger layout changed, so the 16·0 trigger-time script was not re-run; step 21's numbers stand.
- **L2:** `conversations-active` and `-system` have a definition, `definition_at = persisted_at`, and `tables_read = {attempts, conversations, tasks}`. There is no `conversations-gone` row.
- **Tests:**
  - `./equin test` over tasks-core, network/live, conversations/web, conversation-view/web, recover, the queue data-view and queue plugins, all-conversations, agent-notes, welcome, conversation-ui, task-category and agents: bun **571 pass / 1 fail** (59 files); vitest 52 pass.
  - The one failure was all-conversations' A17 check, pre-existing since step 19 or 20 (see deviations). Fixed and re-run: all-conversations **17 / 0**.
- **Build:** green (`6b4c1c8223-1791417019579`, the e2e and profile deploy; the final rebuild after the test and comment edits, `6b4c1c8223-1791418137974`, is green too).
- **Deviations.**
  - D27 not applied, because the condition fails: the rewind e2e reads `GET /api/conversations/:id`. The gone REST endpoint is likewise kept.
  - `conversations-gone` takes `maxLimit: 100`, not the minimum 50. That leaves a reader room to grow past Recovery's 50 by one default page.
  - `ConversationsData` dropped `system` and `hasMoreGone` (no reader). `useConversations` no longer subscribes `conversations-system`.
  - The agent-page creator chip moved to `useConversation`, which uses the by-id read's determinate absent state. This was beyond the plan's reader list.
  - **Pre-existing test fixed:** `all-conversations/server/internal/conversations-oracle.test.ts`'s A17 case read the process-global `routedTableRequirements()`. That registry also holds the tree sets the tasks-core server barrel registers at import, whose routes carry `attempt_id` on `conversations` and `task_id` on `attempts` since steps 19 and 20, so the case had been failing since then. It now registers the suite's three compiled resources on a fresh `createResourceRuntime()` and asserts that runtime's requirements.
  - The tree-oracle harness gained `registerWindow`. The plan named no harness change; the gone window needs it.

### 22 (review round): the dead gone REST read, the gone window at capacity, and the by-id pane's boot cost (2026-10-08)

- **`GET /api/conversations/gone` deleted.** Nothing called it: no web code, no e2e, no CLI. Deleted with it:
  - the `listGoneConversations` endpoint, its `ListGoneQuerySchema` / `ListGoneQuery` exports, the `handle-list-gone.ts` handler and its route;
  - `GonePageSchema` (`conversations/web/use-conversations.ts` and the web barrel), which also drops the `cursor-pagination` import;
  - tasks-core's `listGoneConversations` query and its server-barrel export. The `endedAtBefore` / `endedAtNotNull` filters it alone used are gone too, and `Order.col` is now `createdAt` only.
  - The step-22 deviation that kept it is superseded. `GET /api/conversations/:id` still stays, because the rewind e2e reads it (D27 still not taken). Plugin docs regenerated by the build.
- **The gone window at capacity is now in the tree oracle.** This is a new test, `the gone window at capacity evicts its tail on an entrant and backfills it on an exit`. It runs after the idle test.
  - It inserts its own live `tree-c7` on `tree-a4`. It does not use `tree-c5`, because the C39 cases after it need both live sets non-empty; reusing `tree-c5` emptied `conversations-active` and failed them.
  - It subscribes the window twice: at `encode({ limit: 1 })` (tight) and at its `defaultParams` (wide). Then it closes C7, reopens it (a `where` flip), closes it again, and deletes it.
  - Each step converges against a fresh FULL of each tuple. A new harness method, `view(key, params)`, returns a subscribed tuple's client view, so the test also asserts what each view holds. That proves the limit really binds; a converged view could otherwise be vacuous.
  - Pinned contents and loads. The loads cover both tuples and are compared in either order, because the two tuples' scoped loads land in a nondeterministic order.

  | Step | tight (limit 1) | wide (default) | loads of `conversations-gone` |
  |---|---|---|---|
  | subscribe | [C2] | [C2] | — |
  | gone.enter (C7 closes) | [C7]: C2 evicted by a delete frame, with no read | [C7, C2] | [C7], [C7] (one refill per tuple) |
  | gone.reopen (`status` → working: a where-flip exit) | [C2] (backfilled) | [C2] | [C7], [C7], [C2] (each tuple's refill + the tight backfill) |
  | gone.re-enter | [C7] | [C7, C2] | [C7], [C7] |
  | gone.delete | [C2] (backfilled) | [C2] | [C2] (no read of the deleted row, only the backfill) |

  - No FULL load after the subscribe.
- **The by-id pane's boot cost: recorded and pinned, not seeded.**
  - **The cost.** The conversation pane resolves from `conversations.by-id:rows`, which is lookup-only and so never in the boot snapshot. A reload of `/agents/c/<id>`, even for an active conversation (which resolved at first paint from the boot-hydrated `conversations-active` before step 22), now shows the pane's pending state until one by-id answer lands.
  - **Only the pane gate pays it.** Once the pane resolves, its controls read the same `{ ids: [id] }` tuple, which is already ready, so they are never `null` behind a resolved pane.
  - **Why it is not seeded:**
    - *Seeding the TanStack cache.* Writing hydrated rows into the by-id tuple's cache would give the live-state client a base the server never vouched for. A scoped delta or a 304 could then apply on top of it. That is the "never settle with a placeholder" rule `notifications-client` enforces (`hasAppliedValue`), and a descriptor placeholder reads as `loading` (`query-result.ts`), so it would not help anyway.
    - *A hook-level fallback.* Consulting `conversations-active` / `-system` / the gone window while by-id loads would add two or three subscriptions to every by-id reader. On the deploy there are about 500 readers per page (the sidebar rows). The gone window has no `select`, so every gone change would re-render all of them.
    - *Seeding only the resolver.* Seeding just `useResolveConversation` would mount the controls against a still-loading read, a worse flash than the pane's own pending state.
    - The structural fix is a network/live primitive: a point read declared `seededFrom` same-row collections the client already holds, applied in the client below the vouched-value rule. That is a follow-up, not part of P8.
  - **Pinned in `tree-live-verify`.** A new check, `bootCostOfByIdPane`, runs at the end of the step-22 phase. It inserts an active conversation and loads `/agents/c/<id>` on a fresh session. It records the boot-snapshot response, the first by-id answer (an HTTP read or the socket's `sub-ack`, whichever lands first), and the title painting inside `[data-pane-id="conversation"]`. The sidebar's queue paints the same title from the hydrated set at first paint, so the check is scoped to the pane.
    - It asserts the pane paints only after the by-id answer, so a change that seeds it fails here and is re-pinned on purpose.
    - It prints the latencies even when the check passes.
  - **Measured on deploy `6b4c1c8223-1791421656736` (host load average about 24 to 27):**
    - Clean run: boot snapshot 7669 ms after navigation, by-id answer (`sub-ack`) 8444 ms, pane painted 10145 ms. The answer landed **775 ms after the snapshot**.
    - An earlier run under heavier duress: snapshot 40.9 s, answer 48.3 s (7.4 s after it), paint 66.7 s.
    - In both runs the by-id answer came over the socket, never over HTTP.
- **Runs:**
  - `tree-live-verify` on that deploy: **ALL CHECKS PASSED (45)** (43 before, plus the two boot checks).
  - The run before it failed one pre-existing check ("a new conversation arrives as an entrant of `conversations-active`", a 15 s wait). The run showed `PAGEERROR: Failed to fetch` and a 40 s boot snapshot under host duress. It passed on the clean rerun and on the run before that (45/45).
  - Noise: gateway `429`s, an aborted `task-source-url` read on navigation, a screenshot timeout.
- **Tests:** `./equin test` over tasks-core and conversations (web, server, core): bun **213 pass / 0 fail** (19 files). The tree oracle passes all 7 of its tests.
  - One earlier run failed the main oracle test's `tasks` cost for `conversation.insert`: `[T3, T6]` + rowLoads `[T3]` were expected, and nothing was received. The view still converged. The next three runs passed, so the load landed in a neighbouring step's cost window on a contended host. Its cause is pre-existing and not investigated here.
- **Build:** green, `6b4c1c8223-1791421656736` (the e2e deploy; type-check and docs included). The final rebuild after the last test and e2e edits, `6b4c1c8223-1791426434129`, is green too.
- **Not re-run:** no table's trigger layout changed and no runtime path changed beyond the deleted endpoint, so neither the 16·0 trigger-time script nor a `get_runtime_profile` pass was re-run. The step-22 W4 and W9 numbers stand.
