# Resources [11] session 2: externals declare reads, then the legacy read-set router is deleted

Track: Network Layer › Resources (page `block-f64cfc08-6ec6-4ef3-9122-f143cc24798e`). Design: `2026-10-15-global-live-declared-reads-for-db-values-v2.md` (read its *As landed — session 1*). Closes `task-1791766351-ziteb8` and `task-1791766493-c5sz9f`.

## Context

- Session 1 (`9424cf1133`, on main) made every `source: "db"` value declare whole-table `reads`. Main's `_debug` shows 0 legacy-full.
- Eleven **external** values still query Postgres. They are reached only by the legacy read-set router (`applyLegacyFullChange`) through their captured `legacyReach`.
- So the router, its inversion, the boot read-set seed, `read-set-shrink` and the pane's Legacy FULL section cannot be deleted. The exit criterion is not met.

### Findings that change the original session-2 plan
Exploration ran on 2026-10-17. Six readers and a critic were checked against the code; the reports are in this session's scratchpad.

1. **"No `legacyReach` on a live `_debug`" is not a sufficient gate.** It missed two values that read the DB while loaded:
   - `edited-files`: its loader had not run since boot (304 revalidates). Its DB reads in `revalidate` and `whileSubscribed` are never captured.
   - `background-shell-output`: the path cache is filled in `whileSubscribed`.
   
   It also can never see `review.plugin-changes`, which the `base-exclusions` pack excludes from every composition. The gate becomes a *runtime guard* plus the static check (D5).
2. **Only `automations.catalog` truly needs a view** (`tasks_v`; it filters on the derived `status`). `allow-files` and `review.plugin-changes` read `conversations_v` only for `worktreePath`. They switch to `findWorkspaceOfConversation` (base tables `conversations` + `attempts`).
3. **The background catalog's reads are provider-owned.** `defineDeferredResource` is db-only today.
4. **`studio.table-sample-rows` is already a declared snapshot** (Refresh, sanctioned exemption): it samples views, rollups and feed-excluded tables. It stays as is.
5. **`review.plugin-changes` must declare its own reads.** A routed change reaches only the *tracked* tuples of `edited-files`, so the cascade alone no longer covers a plugin-changes tuple whose upstream is unsubscribed.

## Decisions (agreed 2026-10-17)

- **D1 — `reach` on a non-keyed external.** The runtime accepts it; `routes` stays refused, and keyed external arms keep `reach?: never`.
  - A table write FULL-recomputes the subscribed tuples. A hand `notify()` still works and merges into the same pending.
  - The routed path does not reload an unsubscribed `{}`, except in one case. `routedTargets` also adds `{}` for a param-less entry that has downstream edges, so it keeps the legacy drain's cascade. Test it.
- **D2 — relation reads.** `ReachPlan.relations: RelationRead[]` carries views by name. They are expanded to bases through `relationBases` by an idempotent `indexRelationReads()`, which `setRelationBases` calls; late registrations expand in `indexRouting`. A8 accepts the view's own name.
  - `compiledValueReach` accepts a `PgView` in `tables` and splits it into `relations`. `outsideFeed` stays table-only.
- **D3 — A5 deleted.** `routes` requires a membership, and D32 already refuses a membership upstream, so A5 is a redundant twin. Its tests are re-pinned on D32 (a `routes` upstream still throws), and "a reach upstream may cascade" is added in both registration orders.
- **D4 — deferred external reads (provider declares tables).**
  - `defineDeferredResource` gains the external arm, and the `serveValue` external arm accepts a `reads` thunk.
  - `BackgroundKind` gains `tables` (as `SavedIconSource` did in session 1). The jobs provider names `job_runs` / `job_run_stats`.
  - The catalog's reads are a thunk over the providers, so the consumer names no contributor.
  - `tables` goes on `BackgroundKindSpec` (`catalog/shared/providers.ts`). The registers run before `bindDeferredResources`.
  - **The external arm of `defineDeferredResource` registers its placeholder as external, with its freshness, at definition.** Today the placeholder is built with `externalSource=false` (`runtime.ts:3666-3686`), and the bind does not copy externality (`:3716-3729`). The bind asserts the bound definition has the same externality.
  - Test: a deferred external reports `policy: "external"`, and its `notify()` raises no read-set-gap warning.
- **D5 — the undeclared-read guard (replaces the legacy router as the safety net).**
  - **Guarded set:** every external with `changes: "notified"`. Snapshot, fixed and immutable externals claim no push, so they are out.
  - **Armed per entry, eagerly**, not through `entry.routing`: A8 is armed today only when `entry.routing` is set (`runtime.ts:2494`).
  - **The check:** a captured relation that is not covered is drift, reported once.
    - "Covered" is A8's exact predicate, factored out of `checkRouteDrift`: routes ∪ derived ∪ unfed ∪ relations ∪ drifted.
    - Under `strictRoutes` it throws.
  - **Fail-open:**
    - A non-keyed entry routes FULL, as A8 already does.
    - A keyed external window or point pushes FULL into `drainMembershipFull`, which is what the legacy router did for them.
  - Result: deleting the legacy router can never *silently* stop a value updating. An undeclared read is loud (Reports, `_debug.routeDrifted`) and still correct.
  - **Pane:** `pureExternal` = external with `!routes?.length` and no drift.
- **D6 — no unrouted DB resource.** After deletion, change-feed boot refuses any non-external entry with no routing (`unroutedResourceKeys()`). It is not done in `createResource`, because DB-free test resources stay valid. Main has none: 210 routed + 77 external.
- **D7 — drift survives a restart.**
  - `boot-init`'s legacy read-set seed is replaced by `seedRouteDrift`: each persisted entry's `tables_read` is checked with the same factored predicate. Rollup reads such as `attempt_conv_agg` are derived reads, not drift.
  - This closes session 1's known limit.
  - The notifications `reconcile-read-set` is **deleted**. Its reason was the append-only union being re-seeded, and that union is gone. It also runs after the seed, too late to help.
  - `persistReadSet`'s fallback, for a run that read no table, becomes the entry's route tables, as `floorGuardTables` already does. The union fallback stays for central. Otherwise an empty `tables_read` would force a FULL recompute at the next boot.
- **D8 — transcript lookups declare honestly, and a routed FULL that changed nothing sends nothing.** *(As landed: the skip compares the loader's returned object with the one last sent, not signatures — the signature probe below was built, found to pin stale values (ABA), and replaced. See the v2 doc's "As landed — session 2".)*
  - **Declarations:**
    - `jsonl-events`, `background-shell-output`, `subagent-activity` and `subagent-transcript` share one exported constant, `[conversation_sessions, conversations]`.
    - `conversations` is read on the empty-chain fallback (`resolve-chain.ts:48-52`).
  - **The problem:** a push drain always broadcasts (`sendUpdate`, `runtime.ts:2832-2919`).
    - Declaring `conversations` would re-send the whole transcript on every `conversations` write. That is far more often than today's `conversation_sessions`-only reach: on main, feed counts are 40 vs 2 on the same tuples.
    - The same holds for edited-files' invalidates and the 64 KB shell-output tail.
  - **Primitive (runtime):** a recompute of a tuple whose entry has `revalidate` probes the signature first.
    - If it equals the last one sent for that tuple, the runtime skips the load and the frame, and only acks.
    - This is general: every routed or notified external with a `revalidate` benefits, and so does a db value with one.
  - **Signatures:**
    - `background-shell-output` and `subagent-activity` gain a `revalidate`: stat-based, over the resolved paths.
    - jsonl-events, subagent-transcript and edited-files already have one.
  - **Measured on the deploy:** loads, frames and `frameChars` per value, before vs after (Verification).
  - Narrowing to the conversation's own rows is item [12].

## Per-value declarations

| Value | File | `reads.tables` | Change |
|---|---|---|---|
| `edited-files` | `conversations/…/code/server/internal/edited-files-resource.ts:78` | `_conversations`, `_attempts` | reason covers the `revalidate`/`whileSubscribed` reads (never captured) |
| `allow-files` | `…/allow-monitor/server/internal/allow-files-resource.ts:50` | `_conversations`, `_attempts` | `getConversation` → `findWorkspaceOfConversation` (loader + `watchAllowFiles`) |
| `review.plugin-changes` | `review/plugins/plugin-changes/server/internal/plugin-changes-resource.ts:50` | `_conversations`, `_attempts` | same switch; keeps `recomputeOn` edited-files + `refHeadServed` (legal after D3) |
| `jsonl-events`, `background-shell-output`, `subagent-activity`, `subagent-transcript` | `…/jsonl-viewer/…` | shared `transcriptChainReads` from `transcript-watcher/server` | `session-chain/server` exports `_conversationSessions` |
| `automations.catalog` | `tasks/plugins/automations/server/internal/live.ts:96` | `tasksView` (relation), `tasks_ext_origin`, `tasks_ext_launch_decision`, `automation_launch_batches` | keeps its config notifies |
| `queue-health.pulse` | `debug/…/queue-health/server/internal/pulse.ts:106` | `_deadJobs` | `jobs/server` exports it; its sanctioned exemption is deleted (it would match nothing), and the graphile reads (never captured, `public` only) move into the reason |
| `latency-ledger.summary` (12th, found in review) | `debug/plugins/latency-ledger/server/internal/summary-resource.ts:16` | `tables: []`, `outsideFeed`: the 4 `latency_ledger_*` tables | feed-excluded; the minute flush notifies. Needs `outsideFeed` on the external arm and zero routes allowed |
| `background.catalog`, `background.recent-runs` | `background/plugins/catalog/server/internal/live.ts` | thunk over `BackgroundKind.tables` | jobs provider: `_jobRunStats` / `_jobRuns` |

- Each declaration is written by one agent and checked against its loader's SQL (transitively) by an independent one, as in session 1.
- `no-db-backed-notify` (`scan.ts:163-168`) accepts a depth-0 `reads` key. Its 7 debt entries (8 paths) go, along with queue-health's sanctioned entry. The jobs and studio ×5 entries stay.
- **The inventory comes from code, not `_debug`.** A value that has not loaded since boot shows an empty read-set. Before deleting, a static sweep lists every external `serveValue` / `serveCollection` whose loader reaches Postgres. Each one declares `reads`, is non-push (snapshot, fixed or immutable), or reads only non-`public` relations.

## Framework edits (`plugins/framework`)

- **`resource-runtime/core/routing.ts`**:
  - `RelationRead`, and `relations?` on `ReachPlanInput` / `ReachPlan`, validated in `mintReachPlan`: non-empty reason, no duplicate, not also a route or unfed table.
  - Fix the stale comment at :288.
- **`resource-runtime/core/runtime.ts`**:
  - drop `& { reach?: never }` on the non-keyed external overloads;
  - the external refusal in `routingRecordFor` only for `routes`;
  - `RoutingRecord.relations`;
  - `indexRelationReads()`, with `relationBasesOf` moved out of the legacy memo block;
  - A8 accepts relations; the D5 guard for externals; D6 `unroutedResourceKeys()`; D7 `seedRouteDrift()`;
  - delete A5; deferred external binding (D4);
  - `_debug.relationReads`.
- **`server-core/core/resources.ts`**: `setRelationBases` → `indexRelationReads()` (replaces `bumpReadSetVersion`).
- Non-framework seams:
  - `query-resource/server/internal/routes.ts` (views → relations);
  - `network/live/server/internal/serve-value.ts`: `ExternalReadsOption`, thunk allowed through deferred binding, `reads?: never` on the paged overload;
  - `debug/read-set/web/internal/ceiling.ts`: read `routes` whatever the policy, and `pureExternal` requires `routes === null`.

## Delete (after the gate below)

- **runtime.ts:**
  - `applyLegacyFullChange`;
  - the `tableToResources` / `legacyRouted` inversion;
  - `readSetVersion`;
  - `"legacy-full"` in `DebugPolicy` / `debugPolicyOf`;
  - `_debug.legacyReach`.
- **server-core `read-set.ts`:** `version`, `bumpReadSetVersion`, `seedReadSetIndex`, and their barrel exports. `getReadSetIndex` stays: the union is kept, and the capture asserts in `client.test.ts` and `page-doc-order.test.ts` use it.
- **notifications:** `reconcile-read-set.ts` (D7).
- **change-feed:** the legacy half of `createChangeRouter` (`route-change.ts:105-112`). `routeChange` becomes `routeTableChange`.
- **live-state-snapshot:**
  - the `boot-init.ts:145-154` seed (→ D7);
  - `read-set-shrink-hook.ts`;
  - the shrink CTE and its emit (`persist.ts:184-245`);
  - the `debug/read-set-shrink` plugin. Its config keys are removed; historical report rows stay as history.
- **Read-set pane:**
  - `LegacyFullEntry` / `LegacyFullSection`;
  - `legacy-full` and `legacyReach` in `resources-debug.ts`.
- **`legacyFull` test helper** (`testing/routed-fixture.ts`). Its 16 suites are ported to reach + `routeTableChange`.
- **Keep:**
  - per-run capture (A8 + D5), `relationBases` / D35;
  - `tables_read` (A6 `produced-guard`, boot-catch-up 4a, `readPersistedReadSets`, D7);
  - the non-membership FULL drain;
  - every hand notify / watcher;
  - the `readSet` union, kept for `_debug` and the central fallbacks (`persistReadSet`, `floorGuardTables`).
- **Docs:** the CLAUDE.md of resource-runtime (the "Scoped change routing" opening, A5, legacy), server-core, network/live, change-feed, live-state-snapshot and debug/read-set. Also drop the `read-set-shrink` report kind from `.claude/skills/debug/SKILL.md`. Add an *As landed — session 2* note to the v2 doc.

## Order of work

1. Framework (D1–D7 minus deletion), with tests.
2. Migrate the 11 values, with declare/verify agent pairs.
3. **Gate build:**
   - load each external over HTTP with real params;
   - write to each declared table;
   - `_debug` must show every external with `routes`, an empty `legacyReach`, an empty `routeDrifted`, and 0 legacy-full.
4. Delete, port the suites, update docs.
5. Final build + checks + e2e.

This fits one session. Steps 1, 2 and 4 are parallelisable workflow fan-outs (framework is sequential and done by me; values and suite ports fan out).

## Verification

- **`./singularity test`** on:
  - resource-runtime, query-resource, network/live, change-feed, live-state-snapshot, server-core;
  - debug/read-set, no-db-backed-notify;
  - each migrated plugin (code, allow-monitor, plugin-changes, jsonl-viewer, background, automations, queue-health).
- **New runtime cases:**
  - reach on an external: FULL to subscribed only; hand notify + table change in one flush = one load; ack of a skipped tuple;
  - a reach upstream cascades (both orders), while a `routes` upstream still throws via D32;
  - a relation read reached through its bases only after `indexRelationReads()`, and accepted by A8 under its view name;
  - the D5 guard: throws under `strictRoutes`, fails open otherwise, snapshot exempt;
  - D6 boot refusal; D7 drift reseeded from `tables_read`;
  - a deferred external thunk binds.
- **`review.plugin-changes`:** a unit test that a `conversations` write reaches it while `edited-files` is unsubscribed (unit only; it is excluded from every deployed composition).
- **`./singularity check`** clean, including `plugins-doc-in-sync`, the boundaries, and `resource-runtime:compiled-routes`.
- **Deployed:**
  - the gate (step 3) before deletion;
  - after deletion, `_debug` has no `legacy-full` / `legacyReach` fields;
  - every external that reads the DB shows its routes;
  - `routeDrifted` stays empty after exercising each value.
- **D8 cost:**
  - **Setup:** on the deploy, keep one conversation pane open (with a background shell and a sub-agent) during a few minutes of agent activity.
  - **Count, per value:**
    - for the four transcript values and edited-files: `notifyStats.feed`, loader runs, frames sent and `frameChars`;
    - for edited-files: revalidate runs.
  - **Compare:** main (legacy router) against this branch.
  - **Gate:** frames per minute and `frameChars` are not above main's.
  - Record the numbers in the *As landed* note.
- **The skip-unchanged primitive:** runtime tests check that a FULL with an equal signature does no load and sends no frame but still acks, and that a changed signature delivers.
- **e2e:**
  - edit a page block: `page-blocks` still updates; a new notification still bumps `notifications.unread`;
  - an open conversation's transcript still streams;
  - screenshot Debug → Read-set: reached externals listed under Routed FULL with reasons, no Legacy FULL section.
- **Then:** update the track header (session 2 done, [9] legacy router ticked) and file the next main task, [12] compiled narrowing.
