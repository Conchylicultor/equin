# Scoped change routing P8: execution plan for steps 23 and ★24

**Status:** this plan supersedes the §6 "23" and "★24" work lists of `research/2026-10-06-global-scoped-change-routing-p8-v3.md` (v3) for implementation. v3's decisions D10–D30 and its Known limits stay in force. §3 adds D31–D40, each with a recommendation that can be overridden at approval.
**Verified at:** HEAD `dc1d7409d7`, after steps 16·0–22. Every `file:line` below is current at that HEAD. v3's citations for steps 23 and 24 are stale: `runtime.ts` is now 7242 lines.
**Provenance:** six area mappers re-checked every v3 step-23/24 claim at HEAD, with one adversarial reviewer per area. The C32 gate (§2) was run read-only on main through `_debug`, `query_db` and `get_runtime_profile`.

---

## 1. Context

Steps 16·0–22 moved the task tree (`tasks`, `attempts`, `agent-launches`, `task-categories`) and the conversation lists onto routed `all` collections. The legacy routing machinery now has **no production user**, but it is still compiled, wired and tested:

- **Resource-level `identityTable` / `fanOut` / `recompute:{full}`:** the only producer is the dead `compileQuery` (`query-resource/server/internal/compile.ts`). `queryResource(`, `keyedResourceDescriptor(` and `queryResourceDescriptor(` have no callers; `rg` matches only comments.
- **View forwarding** (the `dependentViews` loop, `change-feed/server/internal/route-change.ts:139-150`). It is also **incomplete**: rollups are feed-exempt, so a `conversations` or `pushes` write no longer reaches readers of `tasks_v`, `attempts_v` or `task_blocking_v`. See §2.
- **The Read-set pane is dishonest (W7).**
  - Every legacy-FULL entry is skipped (`read-set-view.tsx:146`), including `agents` and the 24 other DB-backed `serveValue`s.
  - `readSetBases` collapses a view to one identity base: `edited-files` reads `conversations_v` and shows `["conversations"]`, and `agents` shows the view name `["agents_v"]`.
  - Rollups are filtered out.

The intended outcome:

- The legacy arms, compilers, descriptors, forwarding and drain cascades are deleted, with their spellings made inexpressible (tsc) or loud (runtime throw).
- Legacy-FULL readers of a view are reached through **relation bases**, the transitive view → table expansion with rollups replaced by their sources.
- The pane lists every entry under an honest policy, with its true bases.

## 2. C32 gate: measured, GO

**Method:** on main, read `GET /api/resources/_debug` (204 entries), the `view_table_usage` graph, `pg_stat_user_tables`, and `get_runtime_profile kind=loader`.

**`view_table_usage` at HEAD:**

| View | Reads |
|---|---|
| `tasks_v` | `attempt_conv_agg`, `attempt_push_agg`, `attempts`, `task_blocking_v`, `task_dependencies`, `tasks` |
| `attempts_v` | `attempt_conv_agg`, `attempt_push_agg`, `attempts` |
| `task_blocking_v` | `attempts_v`, `task_dependencies`, `tasks` |
| `conversations_v` | `attempts`, `conversations`, `tasks` |
| `agents_v` | `agents` |

**v3's C32 premise is wrong.** v3 said `tasks_v` and `conversations_v` "already receive" conversation and push writes. Since step 19, `tasks_v` reads rollups, which carry no trigger, so those writes reach no legacy reader of `tasks_v`, `attempts_v` or `task_blocking_v`. This is the C35 silent-stale case, and the step-19 gate missed one reader of it.

**The only live reader whose reach widens is `automations.catalog`.**
- What it is: `automations/server/internal/live.ts:68`, an external value whose loader reads `tasks_v.status` through `openAutomationTaskIds` (`origin.ts:34-46`).
- `tableToResources` does not skip external entries, so its captured read-set is routed like any legacy one.
- **Today it is silently stale.** An agent finishing or pushing changes a task's computed status, but no notify fires.
- **After relation bases** (rollups expanded to their sources), each conversation, push or attempt write causes one FULL reload, throttled to 1/s.
- Cost: about 700 relevant writes a day. That is at most about 0.4 % of one core while the Automations pane is subscribed, and 0 when it is not.
- Step 23 therefore **fixes** a live bug rather than paying a regression.

**Everything else:**
- No other live entry has a view or rollup over the task tree in its read-set.
- `agents` reads `agents_v` → `agents` only, so it is not widened (90 updates in 29 days; 2 loads, avg 8 ms).
- `tasksView`'s other user, `resolveTodoAnnotations`, is on the `read_page` path, not a live loader.

**Rollup churn: not a concern.** The 8.57M / 6.52M `n_tup_upd` on `task_latest_conversation` / `attempt_push_agg` are historical. A re-read moved `task_latest_conversation` by +1, and `attempt_conv_agg` was recreated with 27 updates.

## 3. Decisions (D31–D40; recommended defaults)

| # | Question | Recommended |
|---|---|---|
| D31 | Delete the keyed overload of `defineExternalResource` (`runtime.ts:3520`, interface ~1700)? It has no production user. | **Delete.** Then keyed ⇒ membership ⇒ routed holds, so `diffKeyedScoped`'s runtime use, the scoped branch of `drainPendings` and the keyed legacy `diffKeyed` path die with it. |
| D32 | C37: add v3's new buildEntry throw "a membership entry has no downstream", or rely on A5? A5 already refuses a `dependsOn` onto a routed entry in both registration orders (`runtime.ts:3234-3243`, `3306-3314`). | **Rely on A5.** Add one assert in the DAG rebuild that a membership entry's `downstream` is empty (rung 4, catches an A5 regression). The W5 oracle becomes "the A5 refusal holds, and the membership drain has no cascade". |
| D33 | C30's relation-bases version: v3's second closure (`relationBasesVersion`), or fold it into the read-set version? | **Fold.** server-core's `setRelationBases(fn)` bumps the read-set sink's version counter (`server-core/core/read-set.ts:56`). The `tableToResources` signature stays `${size}:${readSetVersion}`, and C38's `null` branch is unchanged. That leaves one version to keep correct instead of two. |
| D34 | Where to set relation bases? v3 said change-feed `onReady`. | **change-feed `onReadyBlocking`, after `loadKnownRelations`** (`change-feed/server/index.ts:124`). live-state-snapshot's guard and sweep run in its own `onReadyBlocking`, after change-feed's (it depends on change-feed), so D28 sees it. `buildViewDeps` moves there too. The server holder **throws if read before it is set**. The runtime's absent opt means identity, for central and the DB-free harness. |
| D35 | A boot assert that every leaf base reached through a view or rollup is covered, produced or opted out? | **Yes, as an A3-style boot invariant in `installFeed`**, covering the bases of every relation that a live legacy entry can read (`view_table_usage` ∪ `rollupSources()`). The known blind spot is views that read through function bodies; it is recorded as a Known limit. |
| D36 | Shape of the replacement for `applyDbChange`? | `applyLegacyFullChange({table, source, xid?, changedAt?})`. It drops `op`, `ids`, `origin` and `identityBase`. The body is the `tableToResources()` lookup over relation bases, then `scheduleNotify(…, null, …)` per tracked tuple. The `ResourceRuntimeRouters` pick in `route-change.ts:14` is renamed in lockstep (`change-feed/server/testing`, `tree-oracle.ts:290`). |
| D37 | `keyed-resource-scope` rule 3: v3's textual token ban on `identityTable` / `fanOut:`? | **No token ban.** It would hit `View`, change-feed and the pane. Instead: tsc (the slimmed `ScopePolicy`), plus a runtime throw for a cast-through `identityTable` / `recompute` / `fanOut` in `contractToDefinition` and `buildEntry`. Rule 3 keeps its routes branch (`ROUTED_ARMS`). Rewrite the description (`:29`) and the hints (`:264`, `:269`, `:272`). |
| D38 | `no-legacy-resource-spelling`: keep the deleted names, so a stale import gets its replacement hint? | **Keep them.** The W6 audit allowlists that rule and its test. |
| D39 | `identity.ts`: keep the PgView branch and `tableName`? | **Delete them** (`:16`, `:147-177`; error prefixes `:60,67,116,153,160,211`). `arm-plan.ts` passes `identity: {pk}` only. Move `resolveIdentity`'s 9 tests out of `compile.test.ts` into `identity.test.ts` **first**, then narrow `QuerySource` to the routed form. |
| D40 | ★24 policy for a deferred entry before bind? | **A fourth policy, `unbound`** (`deferred.has(key)`). A26's test asserts that every deferred key is `unbound` before `bindDeferredResources()` and has a real policy after. |

Kept from v3 unchanged: D28 (expand A6 through relation bases), the T15 rung-2 narrowing, and the A25 throw.

## 4. Build sequence

Step 23 is one reviewable unit, but it is executed in four sub-steps. Each sub-step ends green on `check` and on `./equin test` over the touched plugins, so a failure is attributable. One background `./equin build` + e2e runs at the end of 23, and another at the end of ★24.

| # | Sub-step | Behaviour change |
|---|---|---|
| 23a | Relation bases (C30) + D28 + forwarding deletion + `applyLegacyFullChange` | **Yes.** Legacy readers of views are reached through bases; `automations.catalog` is fixed. |
| 23b | Runtime deletions: ScopePolicy arms, `coveredOriginsFor`, drain cascades, `affectedMap`/signatures, `notify` `affectedIds`, D31, T15, A25 + the shared routed fixture + suite migration | None intended (dead code), except T15's new refusal |
| 23c | query-resource / live-state / vocabulary / tooling deletions | None (no production caller) |
| 23d | Docs, comments, the W6 audit | — |
| ★24 | A7 `_debug` + pane (`ceiling.ts`) + A26 | Pane only |
| **STOP** | Final review | |

## 5. Work lists

### 23a: relation bases, D28, forwarding removed

**derived-tables:** `rollupSources()` (`derived-tables/server/internal/rebuild.ts:666`) is the input. It has no consumer yet.

**change-feed:**
- New `server/internal/relation-bases.ts`:
  - `relationBases(r)` = `{r}` ∪ the transitive bases through `buildViewDeps`' graph, with every rollup replaced by `rollupSources().get(r)`, recursively;
  - memoized and cycle-guarded (a cycle throws);
  - built once from the view graph.
- `view-deps.ts`: keep `buildViewDeps` (it is the graph source) and delete `dependentViews` / `directDependents`, the reverse closure (`:58-70`).
- `server/index.ts`:
  - in `onReadyBlocking`, after `loadKnownRelations` (`:124`): `await buildViewDeps(db)`, then `setRelationBases(relationBases)` (D34);
  - delete `setRelationResolver(relationIdentityBase)` and `setFeedExemptTables` (`:140`, `:145`) and the import at `:15`;
  - `feedExemptTables()` stays (`:98`, route-coverage, `triggers.ts:37,74`).
- `route-change.ts:131-150`:
  - delete the `dependentViews` loop and the `relationIdentityBase` import (`:7`, `:9`);
  - the one remaining call becomes `applyLegacyFullChange({table, source, xid, changedAt})`;
  - rewrite the header prose at `:72-91`.
- D35 invariant in `install-feed.ts`, beside A3: every base reached by expanding `view_table_usage` ∪ `rollupSources()` is in covered ∪ produced ∪ optedOut, or boot throws, naming the view and the base.

**server-core** (`core/resources.ts`):
- delete the holders `setRelationResolver` / `setFeedExemptTables` (`:150-181`), their wiring (`:361-366`) and the barrel exports (`core/index.ts:72-73`);
- add `setRelationBases(fn)`, which bumps the read-set version (D33), and a holder that throws before it is set;
- runtime opt: `relationBases: (r) => holder(r)`.

**resource-runtime** (`runtime.ts`):
- opts: delete `resolveRelation` (`:1494`) and `feedExemptTables` (`:1507`); add `relationBases?: (r: string) => readonly string[]`, which defaults to identity;
- `tableToResources` (`:2123-2146`): `for t of readSet(key)`, `for b of relationBases(t)`, add `key` under `b`, deduplicated per base;
- `applyDbChange` (`:6897-7031`) → `applyLegacyFullChange` (D36); interface `:1760`, returned object `:7225`, re-exports `server-core/core/index.ts:46` and `resources.ts:438`;
- `_debug` keeps compiling (★24 rewrites it). In the meantime its `readSetBases` uses `relationBases` (`:6479-6492`), with no resolve and no exempt filter.

**D28** (`live-state-snapshot/server/internal/produced-guard.ts`):
- the guard (`:108-125`) tests `relationBases(t)` for each `t` in `tablesRead`;
- the sweep (`:80-98`) selects `resource_key, tables_read`, expands in JS and deletes by key;
- the messages name the base that was hit;
- `boot-init.ts:68-81,108-117` passes `relationBases` in.

**derived-views:**
- delete `relation-identity.ts`, its export (`server/index.ts:6`) and `View.identityTable` (`contribution.ts:15-27`);
- delete the three uses at `tasks-core/server/index.ts:238,239,244` and the prose at `:41-51`.

**Tests (new):**
- `relation-bases.test.ts`:
  - transitive, as in `tasks_v` → `task_blocking_v` → `attempts_v` → rollups → sources;
  - rollup expansion;
  - memoized;
  - a cycle throws;
  - a read before it is set throws.
- A DB-backed `route-change` forwarding test, in the style of `tree-oracle`, with real views:
  - a `conversations` write reaches a legacy reader of `tasks_v` exactly once (red before 23a: no forwarding reaches it);
  - a `pushes` write reaches a reader of `attempts_v`;
  - **positive and negative controls**: an unrelated table reaches nothing.
- produced-guard: a view over a produced table, and a rollup, for both the guard and the sweep. Relabel `produced-guard.test.ts:34`.
- C38: the memo hits on an unchanged version, and misses after `setRelationBases`.
- `route-change.test.ts:58,99`: the legacy arm becomes a non-keyed push resource that asserts one FULL load.

### 23b: runtime deletions

**`runtime.ts`:**

| Item | Where | Action |
|---|---|---|
| `ScopePolicy` | `:539-598` | Keep the routed arms (`:558-578`) without `identityTable?: never` / `fanOut?: never`. Delete the `identityTable`+membership, `identityTable`+scopedMembership, `identityTable`+fanOut and `recompute:{full}` arms. |
| `ServerResourceOptions` | `:735-744` | non-keyed = `{reach?: never} \| {reach; dependsOn?: never}` |
| `DefineResourceInput` | `:612-632` | drop `identityTable` (`:621`, `:631`) |
| `contractToDefinition` | `:768-820` | drop `identityTable` / `recompute` (`:772-773`, `:808-809`). **Add a throw** if any of the three keys arrives through a cast (D37). |
| `ResourceDefinition`, `RegistryEntry` | `:317`, `:326`, `:1090`, `:1098` | delete the fields |
| `routingRecordFor` | `:2934-3022` | drop the `identityTable` pick (`:2937`) and the exclusivity throw (`:2955-2959`) |
| buildEntry guard | `:3156-3160` | becomes `!def.routes`, plus the cast-through throw |
| `derivedIdentityTable` | `:3025-3032`, use ~`:3330` | delete |
| deferred bind | `:3452-3453` | drop both fields |
| `coveredOriginsFor` | `:2149-2184` | delete |
| `scopedResourceTables` else-branch | `:7069-7075` | delete; narrow `ScopedResourceTable.via` (`:1600-1602`) to the route form; relabel the 14 `via: "identityTable"` literals in `route-coverage.test.ts`; `reports-list-oracle` stays green |
| Drain cascades (W5) | `drainMembershipFull` `:4566-4574`, `hasValueAwareDownstream` `:4414-4421`, `drainMembershipScoped` ~`:4811-4827`, `:4913` | delete; owner-mismatch → bare `return` |
| `cascadeDownstream` | `:4263-4396` | reduce to FULL: delete the `affected` / `value` params' `affectedMap` / `signature` block, `SKIP_EDGE` (`:1977`) and `lastSignatures`. Keep the `routedRecompute`, `toSubscribed` and `map` edges and the `cascade` origin (`resolveReverseRoutes` ~`:4981` still uses it). |
| `DependsOnEntry` / `DownstreamEdge` | `:87-140`, `:866-895` | delete `affectedMap` / `signature`. **T15:** narrow `resource` to the external type. |
| legacy `drainPendings` scoped branch (D31) | ~`:5178-5210` | delete `scoped`, `ctx`, the scoped reload and the delta. `diffKeyedScoped` leaves `runtime.ts` and stays exported from `core/testing` (the live-state client round-trip suite uses it). |
| `Resource.notify` `affectedIds` | `:852-860`, ~`:3096` | delete (`LoaderCtx.affectedIds` stays) |
| keyed `defineExternalResource` (D31) | `:3520`, ~`:1700` | delete the overload |
| **A25** | `scheduleNotify` `:3691` | throw on a non-null `affected` for an entry without `membership` |
| **D32** | DAG rebuild | assert that a membership entry's `downstream` is empty |
| **T15 runtime** | the `dependsOn` loop `:3228-3270` + lazy DAG rebuild | throw when a registered upstream has `externalSource === false`, **skipping deferred placeholders**, which report `false` before bind |

**network/live (T15 rung 2, C29):**
- Define one `ExternalServed = ServedValueBase<any, any> & { notify(params?: any): void }` in `shared/compile-value.ts:60`. Narrow on `notify`, not `source`.
- Use it in place of the `AnyServed` copies at `server/internal/serve-value.ts:54` and `central/internal/serve-value.ts:34`. If the server and central copies cannot import it relatively under the boundary rules, they keep local copies of the type, with a `satisfies` test pinning that all three are equal.
- Add type tests (`@ts-expect-error` on a db upstream) in `compile-value.test.ts`, plus a new central `serve-value.test.ts`.

**Shared routed fixture** (`resource-runtime/core/testing/routed-fixture.ts`, re-exported from `core/testing`):
- `identityPlan(table, cols)`, lifted from `runtime-window-membership.test.ts`;
- `defineRoutedTable(h, {key, table, membership: "alias" | "window" | "point", loader, plan?})` → `{resource, feed(op, ids | null, {xid, changedAt})}`. `orderSignatureOf` defaults for alias.
- `legacyFull(h, table, {xid, changedAt})`, which wraps `applyLegacyFullChange`;
- `createHarness`, exported for cross-plugin suites.
- **A `readSet` on a routed entry throws at registration**, so migrated harnesses cannot carry dead options.

**Suite migration** (about 120 tests: about 17 deleted, about 85 migrated, about 13 renamed). Every migrated "no delivery" test gets a positive control.

| Suite | Work |
|---|---|
| `runtime.test.ts` | D `:260,313,371,440,511`; M `:219,683,730,1058`; rename the `applyDbChange` calls at `:182,206,567,595,618,635,656,698` |
| `-scoped-membership` | D `:965,988,1045,1060` (W5 "DELETE forces FULL downstream" becomes the D32/A5 assertion); M about 22 via `membershipHarness` `:83-130`; re-aim `@ts-expect-error` `:1053,1067` |
| `-window-membership` | delete the `legacy` driver (`DRIVERS`, `scopeOf`, `feedChange`), which halves the runs; replace the guards `:982-1075` and `@ts-expect-error` `:989,1015,1029,1072` |
| `-ack-channel` | `keyedHarness` `:46-76` → fixture (13 tests); `:173` keyed external → deleted (D31) |
| `-cascade-attribution` | D 3; move one reverse-route `cascade`-origin test to `-table-routing` |
| `-catchup`, `-stale-flight` | M; the "persisted entry forced FULL on a scoped change" cases become non-keyed push values; `stale-flight:277` uses an upstream through `legacyFull` |
| `-scoped-routing` | D `:126` (empty `affectedMap`); M 3 |
| `-table-routing` | D `:1018`; T15: 10 DB-backed upstreams become external; reword `toThrow` regexes |
| `-changed-at`, `-h5`, `-profiling-hooks`, `-version-shortcircuit`, `-watermark`, `-tracking-span` | M / rename |
| others | `runtime-profiler/install.test.ts` (rename); network/live `compile-window-runtime`, `serve-collection`, `serve-value` (rename); `compile-window.test.ts:89` → a `routes` assertion |

### 23c: legacy compilers, descriptors and tooling

**query-resource:**
- delete `rel.ts`, `compile.ts`, `compile.test.ts` (after D39's test move) and `compile-runtime.test.ts`;
- in `spec.ts`, delete `Hop` / `Edge` / `QueryResourceSpec` (`:100-195`), `edges?` (`:187`) and the `DependsOnEntry` / `Resource` imports. Keep `selectDistinct` (used by `joins.ts:1400` and `recording-db.ts:50`);
- D39 on `identity.ts`;
- barrel `server/index.ts:3,4,30,32,34`, and the description `:46`;
- `core/internal/descriptor.ts`: delete `queryResourceDescriptor` and `QueryResourceContract`, and rename the file `contracts.ts`; `core/index.ts:1`;
- reword the comments at `compile-window.ts:35-36,58-59,63,255,288,308`. `windowQueryResource` (`:536`) stays.

**live-state:** delete `keyedResourceDescriptor` (`core/resource.ts:201-224`, barrel, JSDoc `:125`). `acceptAnyParams` (`:130`) stays.

**resource-vocabulary** (`core/vocabulary.ts`): delete `:7`, `:53`, `:195`, `:221`, `:226` and the `queryResource` marker `:294`, plus the comments `:273,311-312` and `core/index.ts:3`. This is forced together with the barrel by `RegisterMarkersAreLive`.

**Tooling fixtures:**
- re-fixture `parse-resources.test.ts` (`:28-62,204-205,235-243,658`) and `eager-tier-gen.test.ts` (`:174-208,303-312`) on `resourceDescriptor` / `liveCollection`;
- comments at `eager-tier-gen.ts:241,341-342`, `parse-utils/core/helpers.ts:602` and `find-marker-calls.ts:24`.

**keyed-resource-scope:** D37.

### 23d: docs and audit

Hand-edit the prose that names deleted things. `docs/plugins-details.md` and the autogen `CLAUDE.md` sections regenerate on build.

- **runtime.ts comments:** `:180,219,296-361,480-535,608-609,729-732,749-753,765,1085-1106,1446-1475,1749-1760,1812-1821,2149-2155,2358`, and `routing.ts:9`.
- **change-feed:**
  - `install-feed.ts:58-60`, `exclusion.ts:35`, `route-coverage.ts:8-9,48,152`;
  - `listener.ts:151`, `triggers.ts:649`, `route-span.ts:12-13`;
  - `CLAUDE.md:193,204,209,324-325,353`.
- **live-state-snapshot:** `catch-up.ts:50-58,150`, `boot-init.ts:33`; `server-core/core/read-set.ts:3`.
- **CLAUDE.md files:**
  - `server-core/CLAUDE.md:175,307`;
  - `derived-views/CLAUDE.md:131`;
  - `query-resource/CLAUDE.md` (delete the legacy sections `:17-22,29-30,41,70,633-715,897-933,943-960`; keep the `windowQueryResource` section from `:716`);
  - `live-state/CLAUDE.md:401,436-443,488,1008`;
  - `network/live/CLAUDE.md:719,753,774`;
  - `task-category/CLAUDE.md:56`;
  - `keyed-resource-scope/CLAUDE.md:1-30`.
- **Narrative test comments:** `tree-oracle.test.ts`, `task-categories-oracle.test.ts`, `agent-launches-oracle.test.ts`, `page-doc-order.test.ts:319`.
- **`get_runtime_profile` docs** (`profiling/runtime/server/internal/mcp-tools.ts:64,70`) and `runtime-profiler/core/recorder.ts:67`: `cascade` now means "reverse-route id-translation reads (and a routed recompute)". It no longer means `signature` / `affectedMap`.
- **W6 audit**, import-scoped rather than a bare `\brel\(`: no `identityTable` (resource-level), `compileEdges`, `fanOut:` (policy), `keyedResourceDescriptor`, `queryResourceDescriptor`, `\bqueryResource\b`, `compileQuery`, `QuerySource`, `QUERY_RESOURCE_CORE`, `coveredOrigins`, `affectedMap`, `applyDbChange`, `relationIdentityBase` or `query-resource` `rel` import outside the D38 allowlist and `research/`.

### ★24: A7 and A26

**`_debug` per entry** (`handleResourcesDebug`, `runtime.ts:6425-6580`):
- **Add:**
  - `policy: "routed" | "external" | "legacy-full" | "unbound"` (D40). The order is `deferred.has` → unbound, `externalSource` → external, `routing` → routed, otherwise legacy-full;
  - `persisted`;
  - `derivedReads` (`routing.derived`);
  - `tuples` (`tracked.size`);
  - `positionAgeMs` (`now − l2PositionAt`). No `persistedMeta` hook is needed: `persistStats` (`:3873`) and `definitionOf` (`:3912`) already hold this, and `definition` / `l2PositionAt` are already emitted at `:6558-6567`;
  - `routeDrifted: [...routing.drifted]` (the A8 guard's own record, `:2403-2424`);
  - `readSetBases` as the unfiltered union of `relationBases` over the raw read-set.
- **Drop:** `identityTable`, `recompute`, `coveredOrigins` (`:6513-6521`).
- On central every new field degrades to `[]` / `null`.
- **Same commit:**
  - `read-set/shared/schema.ts:77-84` (new fields, parse `policy` and `externalSource`);
  - confirm that `live-state-health/shared/endpoints.ts:21-47` and `live-state-churn/plugins/emit/shared/endpoints.ts:32-42` still parse. They strip unknown fields, and neither reads the dropped ones.

**Ceiling** (`read-set/web/internal/ceiling.ts`, extracted from `read-set-view.tsx:117-164`):
- **`legacyFull`:** every `policy === "legacy-full"` entry, with `key`, `readSetBases`, `tuples` and `persisted`. The `:146` skip goes.
- **`routedFull`:** every route with `map === "full"`, plus its reason (`:131-138`, moved).
- **`drift`:** from `routeDrifted`, in raw-table space, consistent with A8. It is **not** recomputed from the expanded bases, which would false-positive on `tasks_v` → rollup sources.
- **`external`** and **`unbound`:** listed by key.
- **Per-policy counts with key lists** replace the bare `scoped` count.

**Delete:**
- the recompute arm (`:127-130`) and the `identityTable` / `coveredOrigins` branch (`:141-145`);
- Section C: `DiffSection` `:506+`, `computeDiff` `:166-192`, `OverBroadFlag` `:61`, the `useMemo` `:230` and the render `:255`;
- the `Caveat` text about `affectedMap`.
- Rewrite the header `:17-35`, `read-set/shared/schema.ts:3-14`, `read-set/CLAUDE.md:12-45` and `resource-runtime/CLAUDE.md:365-369`.
- Section A (the captured index) now shows rollups too. That is intended: it is the truth.

**A26:**
- **Runtime test:** every registry key appears in `_debug` with a policy from the closed set. Cover routed (via the fixture), external, legacy-full, a deferred entry before bind (`unbound`) and after bind, and a central-shaped runtime with no read-set.
- **`ceiling.test.ts`** (bun, pure logic):
  - a routed entry with a full route and a reason;
  - routed drift;
  - legacy-full with transitive bases (fixtures shaped like `agents` → `agents_v` → `agents`, and `edited-files` → `conversations_v` → `attempts, conversations, tasks`);
  - external excluded from the ceiling (**wrong** — superseded in "As landed ★24": an external entry with a DB read-set is legacy-FULL on its bases, as §2 and W7 say);
  - unbound;
  - empty bases.

**Final review stop.**

## 6. Verification

**Tests:** `./equin test` over resource-runtime, change-feed, live-state-snapshot, derived-views, derived-tables, query-resource, network/live, live-state, resource-vocabulary, codegen, facets/resources, keyed-resource-scope, read-set, runtime-profiler, tasks-core, automations and reports (`reports-list-oracle` must stay green).

**Build:** a background `./equin build`, then `./equin await` until it reports success. It includes `check` (`type-check`, `plugins-doc-in-sync`, `resource-vocabulary`, `keyed-resource-scope`, `no-legacy-resource-spelling`).

**E2E:** `tree-live-verify` passes all checks, at 45 or more.

**`get_runtime_profile` on the worktree deploy**, one kind at a time:

| Check | Expectation |
|---|---|
| W1–W4 (regressions of steps 18–22) | Unchanged from step 22's numbers. A task or attempt write produces 0 loader spans on the conversation lists. |
| W5 | The D32 assertion holds, and the membership drain has no cascade span. |
| C32 / §2 | One scripted conversation update and one push insert produce exactly one `automations.catalog` load while subscribed. Before 23a they produced 0, which was the bug. `agents` gets no extra loads. |
| W6 | The §5 23d audit is clean. |
| W7 | The pane lists `agents`, `pages`, `automations.catalog` and the other legacy-full entries with their transitive bases. `edited-files` shows `attempts, conversations, tasks`, not `conversations`. |
| D35 | Boot passes on the deploy. If it throws, the named base is a real gap: stop and report it. |

**Boot:** the server boots with relation bases set before live-state-snapshot's guard and sweep. The D34 throw would make a wrong order loud.

## 7. Risks (ranked)

1. **A relation-bases miss is silent staleness.** Mitigations: the D35 invariant, the DB-backed forwarding test with positive controls, and the `_debug` check. The function-body blind spot stays a Known limit.
2. **Test churn of about 120 tests.** A fixture that routes nothing passes silently. Mitigations: positive controls, the routed-`readSet` throw, and a per-suite before/after test count recorded in As-landed.
3. **The T15 runtime throw** at DAG rebuild could refuse valid deferred wiring. Mitigation: skip placeholders, with a test for that.
4. **The D34 ordering:** a future plugin reading relation bases in an earlier barrier. The holder throws.
5. **The ★24 schema change** breaks pane parsing if the server and web halves land apart. They ship in the same commit.

## Known limits (added)

- A view that reads through a function body (plpgsql) is invisible to `view_table_usage`, so its legacy readers are not reached and D35 does not catch them. No such view exists at HEAD.
- `agents` stays legacy-FULL (v3 Known limit), and so do the 24 other DB-backed `serveValue`s and the two flat `defineResource({mode:"push"})` values (`pagesLiveResource`, `pageLinksLiveResource`). The ★24 pane now makes them visible.
- `GET /api/conversations/:id` stays (the rewind e2e reads it; D27 not taken). `task-1791411816223-6tbpyf` owns the op-gated rollup route.

## As landed

### 23a

Landed as planned, with these deviations:

- **Relation bases are base tables only.** A view or rollup is not its own base (the plan wrote `{r} ∪ …`): no change is ever routed under a view or rollup name, so `relationBases("agents_v")` is `["agents"]`. Routing and the D28 guard are unaffected.
- **The view graph is read at the start of change-feed's `onReadyBlocking`**, because D35 runs inside `installFeed`. The bases are still installed after `loadKnownRelations` (D34), by one call, `installRelationGraph`, which sets change-feed's graph and server-core's holder together.
- **`buildViewDeps` filters both ends to `public`** (`table_schema` too), since the graph is keyed by bare name.
- **D34 stays loud in live-state-snapshot.** Its `onReadyBlocking` probes `relationBases` before `initSnapshotSubsystem`, outside that function's graceful-degradation catch, so a boot-order bug blocks boot (like A20) instead of disabling L2.
- **The A6 sweep is a read, a JS expansion, and a per-row delete** by `(resource_key, params_key)`, the PK. It is no longer one atomic statement; it returns only rows the delete removed.
- **`coveredOriginsFor` is kept.** Only `_debug`'s `coveredOrigins` reads it now; ★24 removes it. Its comment, and the `identityTable` / `membership` field docs, say they no longer scope legacy routing.
- **Test harnesses were migrated, not deleted,** where their subject is still live: ack channel, watermark, catch-up, scoped routing, profiling hooks, and the scoped-membership alias and floor persist. Their legacy `identityTable` driver became a local routed driver. 23b should lift these local helpers into the shared routed fixture.
- **Tests deleted** (their subject was the removed scoped legacy path): 5 in `runtime.test.ts`, 2 in `runtime-cascade-attribution`, 1 in `runtime-scoped-routing`, 2 in `runtime-scoped-membership`, the 20-case `[legacy]` driver of `runtime-window-membership` (its `[routed]` twin remains), and 9 in query-resource `compile-runtime.test.ts`, which covers the dead `compileQuery` that 23c deletes.
- **Test isolation.** server-core's holder is process-global and throws until it is set. A suite that sets it resets it afterwards (`clearRelationBases`, `core/testing`). The oracle suites that route through the real `routeChange` (network/live `serve-*-oracle`, all-conversations, events-core, reports, release) install identity bases for their duration. Otherwise the legacy router reports "read before set" on every change, over read-sets that other suites in the same bun process left behind. `page-doc-order.test.ts` also removes the read-set entries it records.
- **Test counts.** The touched plugins plus the §6 list and oracles, run as one batch: bun:test 2559 pass, 1 fail, 1 error; vitest 335 pass. The failure and the error are both outside this step's scope. The failure is page/editor `markdown.test.ts` "the generator covers EVERY registered block type", which has no generator for the `map` block. The error is a barrel-import "duplicate key reports.list", which happens only when `plugins/reports` shares the process with a plugin-tree walk. `plugins/database/plugins/migrations` passes alone (206/206).


### 23b

Landed as planned, with these deviations:

- **`keyed ⇒ membership ⇒ routed` is a registration throw, not only a consequence of D31.** `buildEntry` refuses a keyed entry with no membership (after `routingRecordFor`, so a routed spelling error keeps its own message). The flat `defineExternalResource` input is a named `ExternalDefinition` (push / invalidate only, every routing and membership field `never`). A deferred keyed placeholder is exempt until its bind (`buildEntry(..., placeholder)`); a drain that reaches one reports it and skips.
- **The legacy drain is FULL-only and non-keyed.** `drainPendings`' legacy branch lost the scoped ctx, the scoped reload, the scoped delta and the whole keyed FULL branch (dead under the rule above). `diffKeyedScoped` left `runtime.ts`; it stays in `keyed-diff.ts` and `core/testing` (the live-state round-trip suite).
- **D37's cast-through throw** is one helper, `refuseLegacyScopeKeys`, called from `contractToDefinition` (which now takes the calling form, so an external's refusal says `defineExternalResource`) and from `buildEntry` (the flat forms). The `recompute?: never` field also left the routed `ScopePolicy` arms.
- **T15 runtime throw** fires in both registration orders (the `dependsOn` loop, and the other-order loop beside A5, now shared) and again in the DAG rebuild. Deferred placeholders are skipped at registration and judged at their bind (`bindDeferredResources` deletes the key from `deferred` first, so the other-order loop sees it). The rebuild asserts (D32 and T15) run **before** `dagDirty` clears, so a violation stays loud on every flush instead of once.
- **A25** is unreachable through the public API (no producer hands row ids to a non-membership entry once `notify`'s `affectedIds` and `affectedMap` are gone), so it has no direct test; `runtime.test.ts` pins instead that `notify`'s row-id option has no spelling (`@ts-expect-error`) and that an external notify reloads FULL.
- **D32 has no direct test of the assert** for the same reason (A5 refuses every way to give a membership entry a downstream). The W5 test asserts the A5 refusal, `_debug`'s empty `downstream`, and that the alias's I / U / D drains flush cleanly past the assert (its own three deltas). It claims nothing about "reaching no other entry": an unrelated push value could not be reached with or without the deleted cascade, so that assertion could not fail and was dropped in the fix pass.
- **`_debug`** dropped `identityTable` / `recompute` and emits `coveredOrigins: []` (the read-set schema requires an array, not `null`); ★24 replaces it.
- **`ScopedResourceTable.via`** is `` `route "${string}"` `` in both the runtime and change-feed's own copy (`route-coverage.ts`); the 14 `via: "identityTable"` literals became `'route "identity"'`.
- **`applyLegacyFullChange`** lost its point-membership target branch (membership ⇒ routed, so no legacy entry has one).
- **query-resource (forced into 23b, recorded per the brief):** `compile.ts` and `rel.ts` produced the deleted arms, so they no longer compiled. Deleted with `compile.test.ts` (27 tests) and `compile-runtime.test.ts` (2), after `resolveIdentity`'s 9 tests moved to the new `identity.test.ts`. `spec.ts` lost `Hop` / `Edge` / `QueryResourceSpec` and the `DependsOnEntry` / `Resource` imports; the barrel lost `compileQuery`, `compileEdges`, `queryResource`, `CompiledQuery`, `rel`, `Edge`, `Hop` and `QueryResourceSpec`, and its description its `identityTable` clause. Forced with them: the `queryResource` register marker in `resource-vocabulary` (`RegisterMarkersAreLive` is a tsc error otherwise). Left for 23c: D39 on `identity.ts`, `queryResourceDescriptor`, `keyedResourceDescriptor`, the vocabulary's other entries, the tooling fixtures and every comment.
- **network/live T15:** one exported `ExternalServed` in `shared/compile-value.ts`; the server and central `serveValue`s import it relatively (no local copies, so no `satisfies` pin was needed). `ValueRuntime.defineExternalResource` takes a non-keyed contract.
- **The shared fixture** (`core/testing/routed-fixture.ts`): `identityPlan(table, cols)`, `defineRoutedTable(h, { key, table, membership, loader, … })` (defaults: `orderOf` / `windowIdsOf` = the FULL loader's ids, `idsOf` = `params.ids`, the alias's `orderSignatureOf` = `() => ""`, a permissive schema), `feedChange(h, change)` (both routers, as `routeChange` does) and `legacyFull(h, table, o)`. The routed-`readSet` throw is the fixture's: `createHarness` now exposes `readSetOf(key)`, and `defineRoutedTable` refuses a key the harness answers a read-set for (a runtime-level refusal would also hit production, where a routed key's read-set is captured). `createHarness` / `Harness` are re-exported from `core/testing`.

**Suites** (test counts before → after, at the start of 23b):

| Suite | Count | Work |
|---|---|---|
| `runtime.test.ts` | 29 → 33 | D 2 (the stale "without identityTable, a row UPDATE degrades to FULL" and "DELETE degrades to FULL"); M 3 (keyed contract delta, keyed-with-mode refusal, preloadedKeys) onto the routed alias; + "a cascade opens no `cascade` origin" (moved from cascade-attribution); + 4 refusals (D37, D31, T15 both orders, T15 deferred placeholder); + `notify` takes no ids (type pin) and recomputes FULL |
| `-cascade-attribution` | 1 → deleted | its last case (a FULL cascade opens no `cascade` entry) moved to `runtime.test.ts`; the reverse-route `cascade` origin added to `-table-routing` |
| `-table-routing` | 80 → 81 | D 1 (the persisted empty-`affectedMap` skip); + the drain's empty-scoped skip re-pinned through a reverse route that resolves to no host (the over-cap case now asserts W3's ack-only frames and unbumped version; + a persisted-alias case: no load, no persist, only the ack, with a positive control); + the reverse resolve's `cascade` origin; 3 guards re-aimed at D37 / the new order; 1 cascade upstream made external; a `@ts-expect-error` added (keyed external) |
| `-ack-channel` | 18 → 20 | + a `dependsOn` cascade forwards the upstream's xids as the downstream's `ackTx` (the live half of the deleted cascade-attribution case 2), and an overflowed upstream forwards none; `keyedHarness` → `defineRoutedTable` (13 tests); the stale-flight refusal and loader-failure cases onto routed aliases (the latter with a positive control); `identityTable` dropped from two external values; dead `readSet`s dropped; + a positive control on the dropped-`sub-acks` case. The keyed external case D31 names was already gone. |
| `-catchup` | 11 → 10 | D 1 (the stale "persisted entry forced to FULL on a scoped change"); `persistHarness` (6) and the per-run read-set case → non-keyed push values; 2 onto `defineRoutedTable` |
| `-stale-flight` | 8 → 8 | `staleFlightHarness` (5), the concurrency and persist-floor cases → routed aliases with FULL feeds; the value-aware `map` case's upstream → an external push value reached through `legacyFull` |
| `-scoped-membership` | 25 → 26 | `membershipHarness` (~22) and two inline aliases → `defineRoutedTable`; the "skipped" case's plain entry → a routed window; 2 guards re-aimed (`@ts-expect-error` now "every arm requires routes"); + the W5 / D32 case (A5 refusal + empty `downstream`); + a positive control on the N→0 eviction case |
| `-window-membership` | 23 → 24 | drivers lifted to the fixture; the alias-contrast case onto `defineRoutedTable`; guards re-aimed (`identityTable` → `routes`); the type-only `scopePolicyMissingArmFixture` became the test "routes require a membership" (now a runtime throw too); + a positive control on the persistence exclusion |
| `-scoped-routing`, `-profiling-hooks`, `-watermark` | 3, 4, 9 unchanged | drivers lifted to the fixture, dead `readSet`s dropped |
| `-h5`, `-version-shortcircuit` | 4, 8 unchanged | H5c and the two keyed eviction cases onto routed aliases |
| `-changed-at` | 4 unchanged | `identityTable` dropped from three push values |
| change-feed `route-coverage.test.ts` | 20 unchanged | 14 `via` literals relabelled |
| network/live `compile-window.test.ts` | 49 unchanged | `:89` asserts the routes alone |
| network/live `compile-value.test.ts` | 11 → 13 | + T15 types (bare and mapped db upstreams, `@ts-expect-error`) and the runtime refusal of a cast (positive control: an external upstream) |
| network/live `central/internal/serve-value.test.ts` | new, 1 | T15 types on the central `serveValue` |
| query-resource | −29 + 9 | `compile.test.ts` / `compile-runtime.test.ts` deleted; `identity.test.ts` new |

resource-runtime as a whole: 329 → 336 tests (24 files; 25 before) — 333 at implementation, +3 in the review fix pass.

**Results.** `./equin check type-check plugin-boundaries boundary-rules keyed-resource-scope resource-vocabulary:barrels-name-their-exports resource-runtime:compiled-routes no-db-backed-notify plugins-registry-in-sync format-clean`: pass. Tests, bun:test 1458 pass / 0 fail over 148 files plus vitest 16 files green: resource-runtime, server-core, change-feed, live-state-snapshot, network/live, query-resource, tasks-core, reports, runtime-profiler, release, events-core, all-conversations, agents, debug/read-set, primitives/live-state. A second batch — derived-views, derived-tables, codegen, facets/resources, automations, resource-vocabulary, keyed-resource-scope — 169 pass / 0 fail. Neither known out-of-scope failure is in these batches (page/editor was not run; reports did not share a process with it).

**Review fix pass.** Four review findings were fixed:
- the FULL `dependsOn` cascade's `sourceTx` forwarding lost its only test with the cascade-attribution suite. Two `-ack-channel` cases now cover it: the xid reaches the downstream frame, and an overflowed upstream forwards nothing;
- the drain's empty-scoped skip, reached now only by a reverse route that resolves to no host, is pinned directly. It ships no value frame and bumps no version, and on a persisted alias it neither loads nor persists;
- the W5 test's unfalsifiable "reaches no other entry" assertion was dropped;
- the `notify` cast-through test became a `@ts-expect-error` type pin.

Comments were corrected in three places: `PendingNotify.affected` / `deleted` (A25: only membership entries scope, and the legacy drain is FULL-only), and `applyLegacyFullChange`'s fan-out, which said a parametrized entry with no subscribers admits nothing when the code schedules `{}`. That behaviour predates this step and is unchanged. Not fixed here: `server-core/core/resources.ts`'s "Unreachable" `captureWatermark` throw is reached on every flight of a non-persisted entry, so the oracle suites log hundreds of these errors. The cause is `runtime.ts`'s unconditional capture, which is unchanged from main and outside this step's scope.

Re-run after the fix pass: resource-runtime 336 pass / 0 fail (24 files); `type-check`, `plugin-boundaries`, `format-clean` pass.

### 23c

Landed as planned, on top of what 23b already deleted (`rel.ts`, `compile.ts`, `compile.test.ts`, `compile-runtime.test.ts`, the D39 test move, `spec.ts`'s `Hop` / `Edge` / `QueryResourceSpec`, the barrel's legacy names and the `queryResource` register marker). Deviations:

- **D39 went one step further: `QuerySource` is deleted, not narrowed.** `RoutedSource` (`PgTable | EntitySource`) already was the routed form, so `resolveIdentity` and `routedBase` take it and the barrel stops exporting `QuerySource`. `resolveIdentity` lost the PgView branch, `identity.table` and `ResolvedIdentity.tableName` (and `rel` is now `PgTable`). Its error prefix is `query-resource:` (it was `queryResource:`). `routedBase` keeps its runtime refusal of a cast-through view, as the loud backstop under the type. `identity.test.ts` lost the 3 view cases and gained 1: a `@ts-expect-error` on a view that also asserts the runtime refusal (9 → 7 tests).
- **`familyMemberAlias` moved to a new `query-resource/core/testing` barrel.** Touching the core barrel made `plugin-boundaries` (R13, test-only public export) inspect it. The name's only importer outside query-resource is network/live's `serve-collection-scoped.test.ts`, which now imports it from `core/testing`. Shipping code reaches it only through `familyMember`. This was pre-existing debt, and it surfaced because the barrel changed.
- **`core/internal/descriptor.ts` → `contracts.ts`** (`git mv`) is types only now: `Window` / `Point` / `AllQueryResourceContract`. The `zod`, `zod-parser` and `keyedResourceDescriptor` imports are gone, so query-resource's `core/` reaches only live-state's descriptor types.
- **live-state:** `keyedResourceDescriptor` and its barrel export are deleted. `acceptAnyParams`' doc now names the one legacy factory left (`resourceDescriptor`, the two page resources).
- **resource-vocabulary:** deleted the `QueryResourceBarrel` import, `QUERY_RESOURCE_CORE` (constant and barrel export), its `DescriptorFactoryNames` arm, and the `keyedResourceDescriptor` and `queryResourceDescriptor` entries. Reworded the comments. Its `check/` header no longer lists query-resource among the derived `core` barrels. query-resource stays a vocabulary owner through `QUERY_RESOURCE_SERVER`.
- **Tooling fixtures.** `parse-resources.test.ts`: `tasksResource` is an `all` `liveCollection` (its index entry now includes `tasks:rows`) and `queryBackedResource` is gone. The string and comment decoys use `liveValue`. The owner-wrapper case wraps `resourceDescriptor`. The end-to-end case serves an `all` collection through `serveCollection` (adding `tasks:rows` to the expected markers). Two `identityTable` opts literals were dropped. `eager-tier-gen.test.ts`: the owner-wrapper case uses `resourceDescriptor`. The every-factory case covers `resourceDescriptor` / `liveValue` / `liveCollection` (`all`). The factory-declaration case is `resourceDescriptor`'s own signature. The test counts are unchanged (31 and 24).
- **Comments.** These were reworded: `compile-window.ts` (the header, `assemblePoint`, `compileWindowQuery` and the boundary cast), `spec.ts` (the query-surface note, `WindowQueryResourceSpec`'s doc and its `where` / `select` fields), `eager-tier-gen.ts:241,341-342` and `parse-utils/core/helpers.ts:602`. `find-marker-calls.ts:24` is **unchanged**: it names `keyed-resource-scope` as a caller of `markerCallSpans`, which stays true under D37.
- **keyed-resource-scope (D37):** `SCOPE_ARMS` and the `identityTable` branch of rule 3 are deleted. Rule 3 is the `routes` branch alone (`ROUTED_ARMS`). The description, both hints and the rule-3 comment are rewritten, as is its `CLAUDE.md`. That file now records the dropped arm and why a token ban was rejected.
- **D38:** `no-legacy-resource-spelling` keeps `keyedResourceDescriptor` / `queryResourceDescriptor` in its table, and its tests pass. Also left as is: the `live:legacy-descriptors-pinned` comment and the test strings that name the two (`check/legacy-descriptors.ts:21`, `legacy-descriptors.test.ts:75-76`). They pin that a name-based scan does not confuse them with `resourceDescriptor`, which is still true. That is for the W6 audit allowlist (23d).
- **Review fix pass.** Two reviews found no blocker or major. Fixed:
  - Stale names outside the 23d list, reworded: server-core `core/resources.ts`'s preload-declare error (it named `queryResource`, now "defineResource"), tasks-core `queries/conversations.ts`' `listActiveConversations` comment (the lists are `all` collections in `conversation-rows.ts`), and network/live `window-descriptor.ts`' placeholder note (it contrasted with `keyedResourceDescriptor`).
  - `keyed-resource-scope/check/index.ts`: "the two query-resource compilers" became "the query-resource window compiler", the one `defineResource(descriptor, serverOpts)` caller left.
  - `identity.ts`' `wireFieldFor`: the view rationale is gone. The cross-relation by-name fallback stays, for a current reason now stated: it finds a key field that projects only a joined column of the pk's name, so arm-plan refuses it as "projects a joined column" rather than as an unprojected pk. Removing it failed exactly that test in `compile-window.test.ts`.
  - `compile-window.ts`'s `compileWindowQuery` doc is rewrapped, and `query-resource/core/testing` now says shipping code reaches the alias through `familyMember`.
  - The W6 audit pattern above gained `\bqueryResource\b`, `compileQuery`, `QuerySource` and `QUERY_RESOURCE_CORE`.
  - Not fixed here: `docs/plugins-details.md` (`plugins-doc-in-sync`) lags the barrel changes. It is generated, and the parent's `./equin build` regenerates it.
- **Left for 23d:** every doc and comment outside the 23c list that still names a deleted thing. These include `runtime.ts:560`, `server-core/CLAUDE.md:175`, the query-resource / live-state / network/live `CLAUDE.md` sections, `tasks-core/core/resources.ts`, `agents/shared/resources.ts` and the oracle-test narratives.

**Results.** `./equin test` over query-resource, network/live (its `lint/` included), primitives/live-state, resource-vocabulary, codegen, facets/resources, parse-utils, keyed-resource-scope and tasks-core: bun:test 980 pass / 0 fail (93 files), and vitest 156 pass (15 files). A re-run after the `familyMemberAlias` move over query-resource plus `serve-collection-scoped.test.ts`: 143 pass. `./equin check type-check plugin-boundaries boundary-rules keyed-resource-scope resource-vocabulary:barrels-name-their-exports live:legacy-descriptors-pinned format-clean lint-directives-stable`: pass. The first run failed on format-clean, fixed with `./equin format`, and on plugin-boundaries R13, fixed above. type-check includes the type-aware ESLint pass, which is the repo's lint-rule check.

### 23d

Docs, comments and CLAUDE.md prose only; no code behaviour changed (`keyed-diff.ts` was also reflowed by `./equin format`, whitespace only). Autogenerated sections (`## Plugin reference`, `docs/plugins-*.md`) were not hand-edited; `./equin build` regenerates them. Rewritten to describe the code as it stands:

- **resource-runtime.** `CLAUDE.md`: the `ScopePolicy` section (routes + a membership, keyed ⇒ membership ⇒ routed, D37's `refuseLegacyScopeKeys`, how a non-keyed entry is reached, T15 on `dependsOn`), *Bounded membership* (every keyed entry declares one; point routing is `routeTableChange`'s; the alias's `orderSignatureOf` required; a membership drain cascades nothing — A5 + the D32 rebuild assert), *Scoped change routing* (the legacy router as `applyLegacyFullChange` over relation bases and the version-keyed memo; `reach` exclusive with `dependsOn`; the empty-scoped skip is a reverse route resolving to no host; `ackTx` threads through the FULL `dependsOn` cascade), the two FULL drain sites under *Flight freshness*, *Profiling seams* (`cascade` origin = a routed entry's reverse-route resolve), and the harness list (cascade-attribution suite gone; the shared routed fixture). `runtime.ts`: the `ScopePolicy` / `KeyedResourceContract` / legacy-key / membership docs, `wrapOrigin`, `drainMembershipFull`'s header. `routing.ts`, `keyed-diff.ts`, `testing/routed-fixture.ts`, and the window-membership suite's narrative.
- **`cascade` origin.** `runtime-profiler/core/recorder.ts` and `get_runtime_profile`'s description (`mcp-tools.ts`) now say what the code records: `cascade` wraps exactly one call site, `resolveReverseRoutes` (the id-translation read from changed lookup rows to host ids), labelled with the routed entry's key. **Deviation from the brief:** a routed recompute (`recomputeOn`) opens no `cascade` origin — `cascadeDownstream` only schedules the downstream, whose recompute is a `push` load — so the docs say that rather than "(and a routed recompute)".
- **change-feed.** `CLAUDE.md` *Boot-time reconciliation* (A1′ is routes only; D35 `assertRelationBasesSourced` added), `install-feed.ts`, `exclusion.ts`, `route-coverage.ts` (routed, not "scoped", delivery), `listener.ts` / `triggers.ts` (the reconnect sweep goes through both routers).
- **server-core `CLAUDE.md`**: direct `defineResource` callers are the substrate plus the two item-9 page resources; a keyed descriptor takes `ScopePolicy`.
- **query-resource `CLAUDE.md`**: the legacy `queryResource` bullet, the old declaration example, *What it derives* (rewritten for the routed compilers: `RoutedSource`, no view), *Keyed-only* (now *Keyed, except the grouping*), the K/full escape hatch, the mutable-`where` RULE, `scopedMembership: true`, the ordering-staleness caveat (every compiled order has a signature) and the `rel()` section are gone or rewritten; *Boundaries* lists what the barrels export.
- **live-state `CLAUDE.md`**: the descriptor registry's factories, the keyed-delta client/server bullets, *Scoped recompute* (now a routed refill; no hand-scoped notify), the bounded-windows note. **network/live `CLAUDE.md`**: the old-spellings list says which names are deleted (D38 keeps them listed), the pinned-check note, and the "not spelled" line. **keyed-resource-scope `CLAUDE.md`**: the dropped arm is stated as a judgement (no rule for the legacy keys; why no token ban), not as history. **task-category `CLAUDE.md`**, `tasks-core/core/resources.ts`, `agents/shared/resources.ts` and the tree / task-categories / agent-launches oracle narratives name "an old param-less keyed descriptor" instead of the deleted factories. Root `CLAUDE.md` drops `queryResource` from the old-spellings list.

**W6 audit** (`rg` over the repo minus `research/` and the generated `docs/plugins-*.md`, pattern `identityTable|compileEdges|fanOut|keyedResourceDescriptor|queryResourceDescriptor|\bqueryResource\b|compileQuery|QuerySource|QUERY_RESOURCE_CORE|coveredOrigins|affectedMap|applyDbChange|relationIdentityBase`; `rel(` checked as an import of query-resource's `rel` — none). Every remaining hit:

| Class | Hits |
|---|---|
| Allowlisted — D38 | `network/live/lint/no-legacy-resource-spelling.ts` and its test (incl. the test's local `QUERY_RESOURCE_CORE` constant); `network/live/check/legacy-descriptors.ts:21` and `legacy-descriptors.test.ts:75-76`; `network/live/CLAUDE.md`'s old-spellings section describing them |
| Allowlisted — D37 refusal | `runtime.ts` `LEGACY_SCOPE_KEYS` + the `ScopePolicy` doc naming them; the cast-through refusal tests (`runtime.test.ts:890-913`, `runtime-table-routing.test.ts:1501-1509,1805-1809`); `resource-runtime/CLAUDE.md:109`, `keyed-resource-scope/CLAUDE.md` and its `check/index.ts` description, which state the refusal |
| Generated (regenerates on build) | the `## Plugin reference` sections of `server-core`, `change-feed`, `derived-views`, `query-resource`, `live-state`, `resource-vocabulary` `CLAUDE.md`, and `infra/CLAUDE.md:80` (the barrels no longer export these names) |
| ★24-owned | `debug/read-set` (pane `read-set-view.tsx`, `shared/schema.ts`, `CLAUDE.md`), `runtime.ts` `_debug`'s `coveredOrigins: []` emission and type |
| Unrelated homonym (`fanOut`) | `reports` (fan-out ceiling: `fan-out.ts`, `record-report.ts`, `report-kinds.ts`, `core/config.ts`, `CLAUDE.md`, e2e, `config/reports/reports.origin.jsonc`), `debug/report-storm`, `live-state-health`'s per-resource fan-out stat, the transcript / edited-files watchers, `host-semaphore`, `cli/build/run.ts`, `passthrough` lint, `tasks-core/e2e/trigger-time.ts` |
| Real leftover | none — the two found in the pass (`compile-window.test.ts`' "mirrors the queryResource guard", the lint test's comment on what query-resource/core exports) were fixed |

**Checks.** `./equin format` (reflowed `keyed-diff.ts`), then `./equin check format-clean lint-directives-stable type-check`: pass. No tests run (prose-only step).

### ★24

Landed as planned, with these deviations and details (the review fix pass is folded in):

- **The §5 "external excluded" line was wrong, and §6 W7 / §2 were right.** `tableToResources` indexes every entry that is not routed, `externalSource` included, so an external entry whose loader read the DB is recomputed FULL on every write to its bases, beside its own `notify()`. That is how `automations.catalog` is reached (§2), and so are `edited-files`, `allow-files`, `jsonl-events`, `subagent-activity`, `background.catalog` and `queue-health.pulse` on the live deploy. A first cut classified the pane by `policy` alone and showed those entries as bare keys under "External — reached only by their own notify()", which was false. The fix makes the runtime emit the delivery truth itself instead of the pane inferring it:
  - `legacyRouted(entry)` (`!entry.routing`) is the one predicate both `tableToResources` and `_debug` read, and `readSetBasesOf(key)` the one expansion of a read-set through the relation bases;
  - `_debug` emits `legacyReach` = the entry's bases when `legacyRouted`, otherwise `[]`.
- **`_debug`** (`handleResourcesDebug`). `policy` comes from one helper, `debugPolicyOf` (`deferred.has` → `unbound`, `externalSource` → `external`, `routing` → `routed`, otherwise `legacy-full`), typed by a module-private `DebugPolicy` union. Its comment now says that the policy is what an entry is, not all that reaches it. Added `legacyReach` (above), `derivedReads` / `routeDrifted` (sorted copies of `routing.derived` / `routing.drifted`; `[]` when not routed), `tuples` (`tracked.size`, the subscribed tuples), `persisted` (`isPersisted`) and `positionAgeMs` (`Date.now()` − the last-known `l2PositionAt`, `null` when not persisted or no position is known). `readSetBases` stays the unfiltered union of `relationBases` over the raw read-set. `coveredOrigins: []` is gone (`identityTable` / `recompute` were already dropped in 23b, `coveredOriginsFor` before ★24). The `readSet` option's doc and the emission comment no longer say "over-broad edges".
- **Central** calls the same handler with no hooks, so the new fields degrade naturally (`readSet` / `readSetBases` / `legacyReach` / `routeDrifted` `[]`, `persisted` false, `positionAgeMs` null). central-core has no `_debug` path of its own.
- **Read-set schema.** It now models only the fields the pane reads, every one required: `key`, `policy` (a `z.enum` over the closed set), `readSet`, `legacyReach`, `routes`, `routeDrifted`, `tuples`, `persisted`, `positionAgeMs`, `notifyStats`. So a server/pane split fails loudly. Dropped as unread: `mode`, `subscribers`, `dependsOn`, `downstream` (dead since `computeDiff` went), `readSetBases`, `derivedReads`, `externalSource`, `loaderStats` and `topoOrder`; zod strips them. `coveredOrigins`, `identityTable` and `recompute` are gone. The header comment is rewritten.
- **`ceiling.ts`** reads `policy` and `legacyReach` and never re-derives either.
  - `legacyFull` holds every `legacy-full` entry (listed even with empty bases) plus every external or unbound entry with a non-empty `legacyReach`, each with its `policy`, `bases`, `tuples`, `persisted`, `positionAgeMs` and `loadsPerWrite`.
  - `loadsPerWrite` is `max(tuples, persisted ? 1 : 0)`, because a persisted entry nobody subscribes to still FULL-loads its `{}` tuple per write (`applyLegacyFullChange`'s fallback), while an unpersisted one with no subscriber loads nothing (`needValue`).
  - `routedFull` entries are `{ key, route, table, reason }`. The plan named only `route`; the table is what the pane shows.
  - `drift` comes from `routeDrifted`.
  - `pureExternal` lists the external entries with no legacy reach.
  - `keys: Record<policy, string[]>` replaces the bare counts, so every policy has its key list, routed included.
- **Pane.** Sections are re-lettered to the render order: A Notify provenance, B Captured index, C Read-set ceiling. The ceiling section shows:
  - the per-policy counts as a badge cluster;
  - Legacy FULL, one `ChipRow` per entry: the bases as chips, a policy tag when the entry is not `legacy-full` (e.g. `external`), and "N loads/write · M tuples · persisted · 3 s old" on the right;
  - Routed FULL (`key ← table` · reason) and Route drift (warning chips);
  - Routed keys, folded behind a `Collapsible`;
  - External, titled "reached only by their own notify()", which now lists only the pure-external keys, so the title is true;
  - Unbound keys.

  `ChipRow` gained `aside`, `tag` and `empty`. The caveat says that the ceiling is a lower bound until loaders have run. Deleted: the recompute arm, the `identityTable` / `coveredOrigins` branch, the old Section C (`DiffSection`, `computeDiff`, `OverBroadFlag`, their memo and render) and the `affectedMap` caveat. Lists stay hand-mapped `Stack` / `Cluster` children, as before. No `Row` is used, so no `data-view/no-adhoc-row-list` disable is needed.
- **Description.** The plugin description (`web/index.ts`, `package.json`) no longer claims a diff against the `dependsOn` graph. The generated `## Plugin reference` / `docs/plugins-*.md` lag until `./equin build` regenerates them.
- **Sibling contracts confirmed:** `live-state-health/shared/endpoints.ts` (default zod object, which strips unknown keys) and `live-state-churn/plugins/emit/shared/endpoints.ts` (`.passthrough()`) read none of the dropped fields.
- **Docs.** `read-set/CLAUDE.md` is rewritten, including the policy-vs-`legacyReach` distinction. In `resource-runtime/CLAUDE.md`: the *read-set debug pane* bullet (policy order, `legacyReach` and `legacyRouted`, every new field, the central degradation, the A26 pin), the L2 `_debug` sentence and the harness list.
- **A26.**
  - `core/runtime-debug-policy.test.ts` (new, 5 tests):
    - every registry key appears once under a policy from the closed set: a routed window via `defineRoutedTable`, an external value with a read-set (`automations.catalog`, whose `legacyReach` is its bases), two legacy-full values whose bases expand `agents_v` → `agents` and `conversations_v` → `attempts, conversations, tasks`, and a deferred keyed routed collection plus a deferred push value. Both deferred entries are `unbound` before `bindDeferredResources()`, and `routed` / `legacy-full` after it. The test also asserts that the dropped fields are absent;
    - `legacyReach` is checked against the router itself: for each table, `applyLegacyFullChange` loads exactly the entries whose `legacyReach` names it. The cases are an external with DB reads (reached), a pure external (not reached), a legacy value, and a routed entry with a captured read-set that is still never legacy-indexed;
    - `tuples`, `persisted` and `positionAgeMs`: the age goes from `null` to non-negative after a FULL replace persist, and back to `null` once the entry stops persisting although a position is known. `routeDrifted` is set through a `lastReadSet` capture;
    - `derivedReads` reflects the plan;
    - a central-shaped runtime (no hooks) degrades every read-set / L2 field, `legacyReach` included.
  - `read-set/web/internal/ceiling.test.ts` (new, 10 tests; fixtures parsed through the pane's own schema):
    - a routed full route with its reason;
    - routed drift from `routeDrifted`;
    - legacy-full with transitive bases, now using an `attempt-work`-shaped fixture, since `edited-files` is external on the live deploy;
    - `loadsPerWrite` for a persisted and an unpersisted entry with no subscriber;
    - empty bases;
    - an external entry with `legacyReach` in the ceiling, tagged `external` and absent from the pure list (`edited-files` and `automations.catalog` shapes);
    - a pure external outside the ceiling;
    - an unbound entry in the ceiling only when reached;
    - one policy per key;
    - the schema refusing an unknown policy.

**Review findings rejected or left open.**
- **Process.** `plugins/framework/CLAUDE.md` requires the user's approval in the conversation for any change under `plugins/framework/`. ★24 edits `resource-runtime/core/runtime.ts`, its `CLAUDE.md` and a new test there, and the fix pass widened the `runtime.ts` edit with `legacyRouted` / `readSetBasesOf` / `legacyReach`. That approval has to be confirmed with the user before build or push. A workflow brief is not that approval.
- **F3 (most live legacy-full entries have empty bases)** is an observation, not a defect. The caveat now says that the ceiling is a lower bound, and W7 has to be checked after the relevant loaders have run.

**Results.** `./equin test plugins/framework/plugins/resource-runtime plugins/framework/plugins/server-core plugins/debug/plugins/read-set plugins/debug/plugins/live-state-health plugins/debug/plugins/live-state-churn`: bun:test 388 pass / 0 fail; no vitest suites under these paths. `./equin check type-check plugin-boundaries boundary-rules format-clean` passes. Not run here: a `./equin build` and the §6 `get_runtime_profile` / W7 check on the deploy. §6 W7 holds as written: `agents`, `pages`, `automations.catalog` and `edited-files` all appear under Legacy FULL with their transitive bases, the latter two tagged `external`. The parent's final build owns both.
