# Scoped change routing P6–P8, v2: the execution plan for build steps 7–24

> **Superseded (2026-10-09):** the segmented scroll (`useLiveScroll`, `shared/scroll-plan.ts`, every loaded segment live, the 16-segment cap) is replaced by live key-range pages (`useLiveCollectionPages`, `shared/page-plan.ts`) whose liveness follows the viewport — see `research/2026-10-09-global-live-key-range-pages-v2.md`. The scroll parts of this plan describe the old model.

## Context

This is v2 of [`2026-10-01-global-scoped-change-routing-p5-p8.md`](2026-10-01-global-scoped-change-routing-p5-p8.md)
("v1"). v1 was approved. Its **Decisions** and **Defaults** sections stay in force unchanged; this doc does not
re-open them.

P5 (v1 steps 1–6, the reports producer) landed in `3f7fe72db4`. This doc covers everything else: steps 7–24.
- Task: the follow-up of `task-1790690356513-qh4e20`.
- Worktree: `att-1790940635-bg6c`, at HEAD `3f7fe72db4`.

**Why a v2.** v1 was condensed from per-area designs that were session scratch and are gone. So:
- every v1 claim for steps 7–24 was re-checked against the code at HEAD;
- the per-area designs were re-derived from the code and adversarially reviewed;
- the one piece v1 never designed (the step-16 compiler, "16b") was designed and measured on main.

This doc is the durable result. An implementer should not need the scratch.

**What is still wrong** (verified at HEAD; the line numbers have drifted since v1):

| Area | Problem | Where |
|---|---|---|
| Runs (P6) | Every write to the four run-arm tables is a FULL of `runs.revision`, pid-only writes included. | `runs/server/internal/revision-resource.ts:54-113` |
| Runs (P6) | A `deploy_servers` rename never reaches the deploy label (a correlated subquery). | `deployments/.../runs-arm/server/internal/run-kind.ts:41-45` |
| Conversations (P7) | All-conversations and History read `conversations_v` through a tick. That tick hashes non-system rows only and ignores titles. So a task rename never reaches History, and History misses status changes of system conversations. | `all-conversations/server/internal/revision-resource.ts:19-44` |
| Item 7 | `events.runs-revision`, `release.history-revision` and `latency-ledger.revision` are still ticks, and the fetchPage DataView path (`server-query`, `union-query`, `changeTick`) still exists. | — |
| Tree (P8) | `tasks`, `attempts`, `agent-launches` and `task-categories` are persisted non-membership entries, so they reload in FULL on every change they receive. | `runtime.ts:4845` |
| Tree (P8) | On the identity origin, an I or D on a non-membership entry is FULL. | `runtime.ts:6601-6614` |
| Tree (P8) | Any DELETE in a membership drain cascades FULL. | `runtime.ts:4472` |
| Tree (P8), C1 | A push FULLs `pushes.attempts-cascade`, then `attempts` and `tasks`. | `tasks-core/server/internal/resources.ts:164-169`; `tasks_v` reads `pushes`, `views.ts:294-305` |
| Tree (P8) | A task or attempt write FULLs `conversations-*` through view forwarding. | `change-feed/server/internal/route-change.ts:114-125` |

**Measured on main (2026-10-02, `query_db`).**
- Row counts: 4,988 tasks, 4,643 attempts, 4,840 conversations, 4,062 pushes, 1,807 edges, 29 agent launches,
  2,974 categories.
- Today's tree: `tasks_v` takes 72–84 ms (v1 said 67 ms). L2 rows: attempts 2.6 MB, tasks 2.4 MB.
- Lateral prototype: a per-row lateral closure takes **1,472 ms** for `tasks`.
- **Set-based compiled `tasks`** (the 16b design): **31–35 ms**, with 0/0 parity against `tasks_v` (EXCEPT both ways).
- Compiled `attempts` with nested conversations (set-based): 29–32 ms. The legacy pair takes about 13 ms.
- Dependents probe through an indexed lateral: 0.74 ms.
- Scoped closure refill: about 3.5 ms for one id; 14–20 ms in the worst case (75 dependents on a 51-deep chain).

## Decisions and defaults

v1's Decisions table and Defaults 1–9 stand. **v2 adds the defaults below**, each taken because the code or the
measurements forced a choice v1 did not make. Each can be overridden at approval.

| # | Default | Why |
|---|---|---|
| D10 | **The step-17 ★ stop stays, but the set-based full shape ships from 16b on.** It is not a fallback. | Measured: lateral is 20× `tasks_v`; set-based is 0.45×. v1's "if > 2× go set-based" is already decided by the data. The stop still presents the numbers. |
| D11 | **Compiled `attempts` full load at about 2.4× the legacy pair is accepted** (31.7 vs 13 ms). | It runs only at boot, on compaction and on over-cap. It buys one consistent snapshot instead of two reads, and the 2× gate was defined for `tasks` only. |
| D12 | **The closure span budget is re-set.** v1's "about 2 ms" becomes typical ≤ 5 ms and worst case ≤ 25 ms (75 dependents, 51 deep). There is no materialized ancestor rollup. | Measured: about 3.5 ms typical, 14–20 ms worst. Status flips are rare (v1 estimated about 368 per 8 h). |
| D13 | **Order frames ship the full id order on entry or move** (`entered || orderMoved`): about 139 KB for `tasks` and 103 KB for `attempts` per task insert or rank drag. The bytes are recorded at ★17. An `[id, afterId]` order-patch frame is filed as a follow-up task, not built in P8. | Today the same events are a FULL reload, which is strictly larger. A patch frame is a runtime protocol change outside this plan's scope. |
| D14 | **I7c keeps two reads** (the routed `release.history` window, limit 1, plus the external `release.candidate`). The client gate holds `loading` only while the candidate *provably* predates the latest run. | A single external `release.info` reading `release_runs` would violate the `no-db-backed-notify` check (`checks/plugins/no-db-backed-notify/check/scan.ts:21-33`) and miss retention writes. v1's literal gate could stay `loading` forever (another platform, a staged run, a hand-run CLI release, or a permanent refusal). |
| D15 | **I7b is pushed** (recomputed on the minute flush, only for subscribed windows and only when the minute advances). It switches to `load: "on-demand"` if the `latency-ledger:summary-7d` span exceeds 50 ms. The DB-backed external value is sanctioned by **deriving** the no-db-backed-notify exemption from `ExcludeFromChangeFeed` contributions (rung 3), not by an allowlist line. | The tables are feed-excluded by declaration, so the flush is the only change signal. |
| D16 | **`conversations-active` loses `debounceMs: 250` at step 22.** `serveCollection` has none, and the conv→attempts→tasks cascade it protected is deleted. If `get_runtime_profile` over a poller burst shows a problem, `throttleMs` is added to `serveCollection` (mirroring `serveValue`, `network/live/shared/compile-value.ts:331`) in step 22. | The option does not exist today (`query-resource/server/internal/spec.ts:178`); this records the decision instead of leaving it conditional. |
| D17 | **`useConversation` becomes a point read** through a lookup-only `conversations.by-id` collection over `_conversations` and the owner joins, with no `where`. It replaces today's slice across three lists. | The slice never finds a done conversation older than the newest 30 (`conversations/web/use-conversations.ts:73-94`), and window reads have no `select`. |
| D18 | **The `agent-launches` wire shape stays nested.** `latestConversation {id,title,status} \| null` is one `ExprField` (`json_build_object`) with a parsed decoder. | Flattening it (v1 table) would change the wire for five agents components. v1 listed it as design, not a Decision. |
| D19 | **The `tasks` wire field stays `dependencies`, and `minPushAt` keeps its name.** v1's `dependsOn[]` / `minCompletedPushAt` are internal alias names only. | `TaskListItem.dependencies` (`tasks-core/core/internal/schema.ts:77`) has six readers. |
| D20 | **The ~20 `pages` / `page-links` entries in the network/live lint "Item 3" group move** into a new permanent group, *Declared legacy-full (item 9)*, which A27 pins. Only the tree entries are deleted. | Those resources stay legacy-full by v1's own Known limits; deleting the whole group would fail lint on them. |
| D21 | **Rollup heal detection is a generated reconcile.** It runs diff-first: upsert only rows `IS DISTINCT FROM` the aggregate, with RETURNING counts. There is no md5 checksum. | An md5 checksum is two full scans per rollup inside the hot-swap-blocking schema transaction. The generated form follows from "rollups become data" (A21). |
| D22 | **Persisted `serveValue(source:"db")` entries get no definition fingerprint.** These are `agentRows`, `conversationsGoneStats`, `pages` and preloaded values. A loader change serves a stale L2 value until their first change, or until the hourly compaction, which now covers every persisted key. This is recorded as a Known limit. | Fingerprinting a loader means hashing `Function.toString()`, which is fragile. Compaction bounds the staleness to one hour. |
| D23 | **Runs `:groups` stays minted but is subscriber-gated.** No runs surface declares facets, and the runtime profile asserts that no `runs:groups` tuple is subscribed. | Over the computed `outcome` / `label` it is the O(ledger) `GROUP BY` that the tick's docblock rejected (`revision-resource.ts:31-35`). |

**User-visible behaviour changes** are v1's list, plus:
- The All-conversations and History lists gain a **Task** (`taskTitle`) field: searchable and filterable, not a facet.
- History's "Models" view groups by a non-sortable `model`, so its sections build per loaded segment.
- Switching the latency window shows a loading state instead of the previous window's numbers.
- `useConversation` now finds any conversation by id, including old done ones (D17).

## What v2 changes against v1 (the review findings that matter)

**Blockers fixed**

| # | Finding | Fix |
|---|---|---|
| 1 | Step 16's compiler half had no design. | Designed below as 16b, measured, and adversarially reviewed. |
| 2 | **A18 was a boot-only sweep.** During a hot swap the old backend keeps persisting after the new backend's sweep (`database/server/index.ts:31-45`), so a stale-definition row would be seeded and served on every page load. Worse, the next floor persist would stamp it with the new definition. | The definition becomes a **read predicate** on every L2 read path. |

**Shared primitives with one owner** (v1 had several areas designing them differently)
- Raw SQL execution: `QueryDb.execute` plus `decodedRow`, at step 10.
- One `ArmPlan` contract with a `mode` union, at step 9.
- One I7p spec, at step 8.0.

**Correctness fixes**
- **Union compile timing.** The P6 union compiles **deferred**, at `bindDeferredResources`. Arms register in the register phase, so compiling at module eval would serve zero arms with no error.
- **`ExprField` cannot leak server-only columns.** It renders over defaulted *wire* columns, and its value type is checked against the row.
- **`agent-launches` routes are reverses, not an alias.** `attempts.task_id` is a task id, not a launch id.
- **`task_latest_conversation` needs a per-source maintain branch.** Attempts rows carry `task_id`, not `attempt_id`.
- **The compact job covers every persisted key**, not only aliases. Prune and catch-up use the *global* `min(position)`, so an idle legacy key would otherwise pin the floor.
- **Catch-up backstop.** When the backstop fires (oldest retained xid > floor), catch-up recomputes every persisted key and skips L2 seeding.
- **New A36.** A column-carrying route on a table whose trigger is still plain `live_state_notify` degrades silently to FULL; A36 makes that a boot failure.
- **New A34.** Rollup maintain takes per-key advisory locks, fixing a lost update between concurrent writers.

**Ordering fixes**
- Step 14 needs **all of step 8** as well as steps 5, 12 and 13.
- Step 13 needs step 7 (the C3 payload cap).
- Step 21 lands together with `task_latest_conversation`'s `attempts` source (A35).

**Smaller corrections**
- I7c: `closeReleaseRow` needs `.returning()` and `kind` in its select-guard. The candidate signature must cover the existence of the dist binary.
- I7a: `requireRun` stays (`handleListRunEvents` uses it).
- `conversations-gone` as a window needs `filterable` and `sortable`.
- Barrel re-exports to remove:
  - `task-category/web/index.ts:6-9`;
  - `agents/web/index.ts:27`;
  - `listPushes` at `tasks-core/server/index.ts:120`.
- Step 23 must remove the vocabulary entries `queryResourceDescriptor` and the `queryResource` marker as well.
- The step 23 test inventory is larger than v1 listed.
- The docs and comment sweep is assigned to steps 20 and 23.

## Shared framework (steps 7, 9, 10)

### Step 7: `reverse.column?`

- `routing.ts:85-99`: change `column: string` to `column?: string`. When absent, the changed table's single-column
  PK is read from `change.ids`.
  - There is no logic change: `valuesOf` (`routing.ts:380-397`) and `tableLayoutRequirements` (`:171-172`) already
    handle absence.
- `query-resource/server/internal/joins.ts` `reverseMap` (`:804-806`): omit `column` iff
  `tablePrimary(spec.table) === spec.pk`. This is the same rule as `joinRoute`'s alias arm (`:842-844`).
  - A lookup on a UNIQUE non-PK column keeps `column` (A4 allows it, `:413-417`), and a test pins it.
- Today the only production reverse is event-list's `_eventSources.id` lookup. Its `event_sources` triggers rebuild
  once at the next boot.
- Tests:
  - `serve-collection-joins.test.ts:226,234` (expected shape);
  - a new unique non-PK case;
  - A17: `tableLayoutRequirements` gives `carry: []`, and the installed layout read back in
    `serve-collection-lookup-oracle` shows the same;
  - `runtime-table-routing`: a column-less reverse resolves `change.ids`, `ids: null` ⇒ FULL, `[]` ⇒ untouched.
- Step 7 is a correctness precondition for **step 13** (C3: without it a 150-row `tasks` update loses `ids`). For
  step 12 it is only an optimization.

### Step 9: one `ArmPlan` contract; the compile-window split (byte-identical)

`compile-window.ts:288-865` is one 580-line function. Split it into `planArm` and `assembleWindow` (and, in
`compile-groups.ts:86-178`, into `planGroupArm` and `compileArmGroups`). The contract is pinned **once**, so steps 12
and 16b consume it unchanged:

```ts
type ArmMode = { kind: "window" } | { kind: "point" };      // 16b adds { kind: "all" }
interface ArmPlan<Row, P> {
  label; base: RoutedBase; joins: JoinPlan; pkColumn; keyField;
  projection: readonly { outer: string; read: ReadColumn | ExprField }[];   // ordered: the union aliases positionally
  routes: readonly RawRoute[];                       // ids prefixable (step 11)
  tuple(params: P): TupleReads;                      // moves, uses, included — today's routedReads.tuple
  recomputeOn?;
  order?: { memberAliasOf; orderPlanOf(params); cutWhere(params) };    // window mode
  // render-only: returns SQL / QueryStep, never executes
  fullQuery(params, limit); scopedQuery(params, ids); idsQuery(params, limit); pointQuery(params, ids);
  fold(rows, params);
}
```

- **`assembleWindow(arms, outer)`** owns:
  - the signature-field list (and asserts every arm projects the same field per signature column; used from
    step 12);
  - `$key`;
  - the loaders, `windowIdsOf`, `membership` and the scope policy.
- **Guard order is unchanged.** The codec, orderBy, maxLimit, defaultLimit and A15 guards (`:405-473`) still run
  before `planArm`, so no misuse message changes.
- **What must not change:**
  - builder call order;
  - the number of `tuple()` calls;
  - the memo keys.
- **Golden.** `network/live/server/internal/compile-sql-golden.test.ts` checks a fixed matrix:
  - static and function `orderBy`;
  - select-all;
  - extension, lookups, keyed side, defaults, base `where`;
  - scroll cuts with NULL keys;
  - `columnScope` family;
  - contributed;
  - lookup-only;
  - static-`where` point.

  For each it records the full, scoped, `windowIdsOf`, point, reverse-`resolve` and groups SQL and params, plus routes,
  `usesOf`, signatures and folded output.
  - The test **only reads** `plugins/network/plugins/live/server/testing/compile-sql-golden.json`, and fails loudly when
    it is missing.
  - The golden comes from `plugins/network/plugins/live/scripts/gen-compile-golden.ts`, run with
    `./equin run` on the **pre-split** code in the same step.
  - Groups are exercised through the `:groups` descriptor that `serveCollection` mints.
- Step 9 lands alone.

### Step 10: `ExprField`, and raw-SQL execution

**`ExprField`**
- **Location:** `query-resource/core/internal/expr.ts`, exported from the core barrel. It is browser-safe, with a
  type-only drizzle import.
  - Signature: `expr((j) => sql…, { decoder, sqlType, notNull? })`.
  - `SQL_TYPE_RE` moves here. union-query keeps its own copy until step 12 deletes the plugin.
- **`j` is the plan's defaulted wire columns** (`JoinWireColumns` rendered through `render`, so an extension column
  reads its COALESCE default).
  - A server-only read must be declared: `serverOnly: [col]`.
  - An expr that is exactly one bare column is rejected ("use a ColumnRef").
- **Value type.** `V` must be a JSON wire scalar, or the expr declares `wire: WireCodec`, applied like
  `columnWireCodec`.
  - `ColumnOverrides` and `WireCheck` require `ExprField<…, V>` to equal `Row[K]`; `notNull` omitted ⇒ `V | null`.
- **`readExpressions`** becomes the union `{kind:"column"} | {kind:"expr"}`. 16b adds `{kind:"aggregate"}`.
  - `columnOf` / `relationOf` throw on an expr.
  - The 11 call sites move to `nameOf` / `memberOf` / `relationKey` / `relationsIn`: `compile-window.ts:212, 487,
    490, 518, 581, 663, 665, 702` and `serve-collection.ts:474-479, 576, 730, 759`.
- **Render each expr once per compile** and reuse the SQL object. `readExpressions` is keyed by identity.
- **Provenance.** It is read off the rendered SQL by `columnsIn`, which throws on an undeclared table. That makes
  the deploy label's correlated subquery unwritable.
- **Binding.** `serveCollection`'s binding accepts an expr for any field except `id`. A runtime nullability
  backstop sits at `:470-482`.

**Raw execution.**
- `QueryDb extends SqlExecutable<SQL>`: it adds `execute`, today it is select/selectDistinct only (`spec.ts:78-81`).
  The `recordingQueryDb` seam returns a full `SqlResult`.
- **`decodedRow(projection)`** lives in `sql-projection`, which exports the existing `toMapper`
  (`decoders.ts:13-21`).
  - It requires the exact key set (A31).
  - A null skips the decoder.
  - Every raw read goes through `executeRows(db, { query, row: decodedRow(…), label })`.
- **Why raw SQL is needed:**
  - the P6 union, whose outer order keys are expressions; drizzle `unionAll` rewrites PgColumn chunks to bare
    identifiers (`drizzle-orm/pg-core/dialect.js:324-331`);
  - the P8 recursive closure; drizzle 0.36.4 has no recursive CTE.
- **Tests:** `serve-collection-expr.test.ts` covers:
  - projection, filter, NULLS sort, scroll cut cast, `GROUP BY` an expr;
  - route columns;
  - membership moves through a lookup;
  - throws: undeclared table (including the `_deployServers` subquery), bad `sqlType`, expr id, non-null schema on a
    nullable expr, bare column;
  - an extension default seen by the expr;
  - `@ts-expect-error` for decoder ≠ field, a Date-valued expr on a string field, and `j.undeclared`.

  The lookup oracle gains an expr-over-lookup rename case.

## Item 7: step 8 (I7p, then I7a, I7b and I7c, in any order)

`network/live/lint/index.test.ts:50-75` already forces each converted file out of the burndown in its own step.

### 8.0 I7p: typed `liveValue` params (the only spec)

- `params` may be a record `{ [name]: ZodParser<string> }`. Every name is **required**. There are no optional record
  params until a consumer needs one.
- **At declaration**, walk `_def.typeName` and reject `ZodEffects`, `ZodDefault` and `ZodCatch`. Also reject a
  parser for which `safeParse(undefined)` succeeds.
- `paramsGate` (`live-value.ts:300-337`):
  - `safeParse` each present name;
  - on failure, throw `ResourceContractError`;
  - when the parsed value is not the wire string (`data !== v`), throw a plain Error (the backstop).
- `validateParams` stays `void`, so the runtime is unchanged and the loader's typed `P` is what it actually
  receives.
- The overloads beside `:209-221` return `LiveValue<T, { [K]: z.output<R[K]> }>` (T16).
- **Tests:**
  - the gate accepts and rejects;
  - a transforming or defaulting parser throws at declaration;
  - `@ts-expect-error useLive(v, { window: "2h" })`;
  - `@ts-expect-error z.number()`.

### 8.1 I7a: `events.runs-revision` → the `events.source-runs` collection

- **core:** in `events-core/core/internal/resources.ts`, delete the tick (`:33-51`) and add
  `liveCollection("events.source-runs", …)`:
  - row `EventSourceRunSchema`, `id: "id"`;
  - filterable:
    - `sourceId`;
    - `outcome: liveText(z.enum(RUN_OUTCOMES))` (the `enum` operator set is domain `text`, so it is compatible);
    - `error`;
    - `startedAt` / `finishedAt`;
    - the counts and `durationMs` as `liveNumber`;
  - `flags` is display-only (Default 6);
  - default `startedAt desc`, limit 100, `maxLimit: 500`, `scroll: true`, `columnScope: "events.source-runs"`.
- **server:** `serveCollection(eventSourceRuns, { from: _eventSourceRuns })`. Delete:
  - `listEventSourceRuns` / `getEventSourceRun` (`endpoints.ts:125-145`);
  - their handlers (`handlers.ts:103-116`);
  - `listRuns` (`sources-repo.ts:170-181`).

  **`requireRun` stays.**
- **web:**
  - `useEventSourceRun` = `useLiveRow`;
  - `runs-section` uses a module-level `liveDataSource(eventSourceRuns, { searchable: ["error","outcome"] })`,
    `.scoped({ where: { sourceId } })`;
  - the panes resolve with `resolveRow`;
  - the `caveats`, `model-call` and `extracted-events` sections move to `LiveRowResult` arms.
- Delete the lint lines `:115-118`. The first routed layout on `event_source_runs` means one trigger rebuild.
- **Tests:**
  - a scoped oracle on the pattern of the deploy run-history oracle;
  - e2e `runs-live-verify` with a custom-column sort.

### 8.2 I7b: `latency-ledger.revision` → `latency-ledger.summary`

- **core:** `liveValue("latency-ledger.summary", { schema: LatencySummarySchema, params: { window: z.enum(LATENCY_WINDOWS) } })`.
  Delete `getLatencySummary`.
- **server:**
  - `serveValue(…, { source: "external", loader: ({window}) => loadLatencySummary(window) })`, with a comment
    stating why: feed-excluded DB truth whose change source is the flush.
  - `noteFlushedMinute` keeps its monotonic guard and notifies **only subscribed** windows. Check `scheduleNotify`
    for an unsubscribed tuple (`runtime.ts:2955`).
  - Update the `ExcludeFromChangeFeed` reason text.
- **check:** `no-db-backed-notify` derives its exemption from `ExcludeFromChangeFeed` contributions (D15).
- **web:** `responsiveness-section` uses `useLive(latencySummary, { window })` through `ChartState`.
- Delete lint lines `:119-122`.
- D15: measure the `summary-*` spans before landing.

### 8.3 I7c: `release.history-revision` → candidate and latest

- **bundles** (DB-free, CLI-safe): `bundleSignature({namespace, composition, platform})` sits beside `resolveBundle`
  and reads the same paths. It is built from:
  - the existence of the composition directory;
  - `realpath(latest-<platform>)`, or the refusal reason;
  - the `RELEASE.json` mtime and size;
  - **the existence of `dist/<comp>-web-<platform>`**.
- **core:**
  - `ReleaseCandidateSchema = { resolution, staleness, observedAt }`, with no `run` (T17);
  - `releaseCandidate = liveValue("release.candidate", { params: { composition: z.string().min(1), platform: PlatformTagSchema } })`;
  - delete the candidate and latest endpoints, `ReleaseLatestRunResponseSchema`, and the barrel exports
    `release/core/index.ts:23-47`.
- **server:**
  - `createSignedMemo` keyed `${composition}\0${platform}`, signature = `rev-parse HEAD ‖ bundleSignature`, evicted
    on last unsubscribe.
  - `serveValue(…, { source: "external", recomputeOn: [refHeadServed], revalidate })`.
  - Failed computes are not cached (`git-state-memo.ts:71-76`), so a corrupt `RELEASE.json` is the value's error
    arm.
  - `closeReleaseRow` (`run-state.ts`): add `kind` to the select-guard (`:127-136`) and `.returning({ id })` to the
    UPDATE. Notify `{composition, platform}` only when a row came back, `kind === "candidate"`, the target is web, and
    `isPlatformTag(manifest.platform)`.
  - Delete `handle-candidate.ts`, `handle-latest-run.ts`, `history-revision-resource.ts` and **`wire-columns.ts`**.
- **web** (`use-release-info.ts`):
  - `ReleaseInfo = no-platform | loading | error | ready`.
  - The reads are `useLive(releaseCandidate, platform ? {…} : null)` and
    `useLive(releaseHistory, { where: { composition }, orderBy: startedAt desc, limit: 1 })`.
  - **Gate (D14):** hold `loading` only when **all** of these hold:
    - latest is `succeeded`, `kind: candidate`, the same platform, target web;
    - and **either** `resolution.ok && runId ≠ latest.id && builtAt < latest.startedAt`,
      **or** the refusal is `no-releases` / `no-pointer` `&& candidate.observedAt < latest.finishedAt`.
  - `releaseStateOf(info)` feeds `release-field.tsx:72`.
  - `release-chip`, `release-field` and `remote-deploy-section` render all four arms.
  - Delete `useRevisionRefetch`.
- Delete lint lines `:123-127`. Update the release and remote-deploy CLAUDE.md.
- **Tests:**
  - an oracle on `release.history` limit 1;
  - e2e `release-info-live-verify`.

## P6: runs as a routed union window (steps 11–12)

### Step 11: routes, handles, overload

**11a. `query-resource/server/internal/routes.ts`**
- `RawRoute` (identity/alias with `encode?: never`). `compiledRoutePlan` takes `RawRoute[]` (T10). Delete the P4
  throw (`:121-135`) and replace its test with a `@ts-expect-error`.
- In `query-resource/core`:
  - `KIND_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/` (it already exists inline at `live-columns.ts:130`; move it);
  - `armKeyCodec(kind)`: `encode = kind:raw`; `decode` strips the prefix once (raw ids may contain `:`);
  - `armKeySql(kind, idCol)`, with a test of byte-equality against `encode`.
- `compiledUnionRoutePlan(arms, usesOf)`:
  - prefixes route ids `<kind>` / `<kind>.<alias>`, asserts uniqueness (A14) and that every identity carries no
    `column`;
  - identity and alias gain `encode`;
  - reverse wraps `resolve`: decode `within` to this arm's raw ids; an empty kept set skips the probe;
    `within === null` passes through (an unbounded reader); the answer is encoded; `over-cap` passes through.

**11b. `live-columns`**
- `LiveColumnsDeclaration.owner` is one of `contributed` / `scoped` / `arm{collection, arm}` (T11).
- Exhaustive switches in:
  - `query-codec.ts:158-178`;
  - data-view `live-fields.ts:55-66`;
  - `serve-collection.ts:316-319, 932-941, 966`;
  - `serve-columns.ts:208`;
  - `liveColumns` and `scopedLiveColumns`.
- `liveArmColumns(collection, arm, { row, filterable, sortable })`:
  - wire names `<arm>.<field>`;
  - `read(row)` returns null for another arm's row, parses its own slice (WeakMap-cached), and **throws** on its own
    arm's row when the slice is missing (A16).

**11c. The `arms` overload of `liveCollection`**
- `arms: { discriminator }`, `scroll: true`; `contributed` and `columnScope` are `never` (T12). Runtime throws mirror
  `:328-339`.
- Rows carry `$columns` (`withColumnsSchema`).

**11d. Scanner**
- Add register markers for `serveUnionCollection`, plus `deferredUnionWindowQueryResource` if it is exported. The
  check derives marker names from every barrel export that returns a served resource
  (`resource-vocabulary/check/index.ts:51-58`).
- An `arms` collection declares `default`, so `requires` needs no change.

### Step 12: compiler, server spec, runs, arms, web

**12a. `compile-union-window.ts` (new)** reuses `planArm`.
- **Bind-time checks (A14):**
  - kinds unique and matching `KIND_RE`;
  - `id` is the single-column PK;
  - every outer column has a `sqlType`;
  - the discriminator and key are compiler-projected.
- **Per-arm projection** uses positional aliases: `__kind`, `__key = armKeySql`, `__c<i>` (the expression, or
  `NULL::<sqlType>`), and the scroll key parts.
- **Nullability** is computed **once at bind, over all registered arms**. This deliberately differs from
  union-query's surviving-arms rule (`compile-union.ts:277-284`), so that signatures and cuts never depend on pruning.
- **Total order:** the tuple keys, then `runKey`.
- **Shapes** (all through `QueryDb.execute` + `decodedRow`):

  | Shape | SQL |
  |---|---|
  | Full | `(SELECT … WHERE arm.where ∧ whereOf ∧ cut ORDER BY … LIMIT n) UNION ALL …`, then the outer cut, order and limit. Zero arms use the `WHERE false` scaffold. |
  | Scoped | ids decoded and grouped by kind (unknown or undecodable ⇒ dropped); per arm `… ∧ id = ANY($raw)`; no order. |
  | `windowIdsOf` | The full shape projecting `__key` only. |
  | Point | Grouped by kind over **all** arms, keeping `arm.where`. An unknown kind or bad id is **absent**, never a contract error. |
  | `:groups` | `compileArmGroups`: per-arm `GROUP BY`, then the outer `sum`. |
- **Gate** = per relation: every select expression ∪ `arm.where` ∪ id ∪ `whereReads` ∪ signature. So `pid`,
  `leg_run_id`, `launched_from` and `updated_at` writes route nowhere.

**12b. `network/live/server/internal/serve-union.ts`**
- `serveUnionCollection(collection, { arms: () => UnionArmBinding[] })` compiles **deferred** through
  `deferredWindowQueryResource`, the precedent at `serve-collection.ts:948-994`. Routes therefore exist before the
  change-feed's ready-barrier trigger rebuild.
- Base fields bind by name. Handle fields project as `<arm>.<field>` and fold into `$columns[arm]`.
- **Filter targets:**
  - in-arm: the expression;
  - other arms: a NULL constant;
  - the discriminator: the constant `'<kind>'`.
- **`armsOf(params)`:** AND-reachable clauses only (moved from `compile-union.ts:129-137`). `testClause`
  (`filter/core/internal/matches.ts:41`) on an arm constant prunes; a negative op or `isEmpty` keeps the arm.
- The decode is strict over the static set of arm handles.
- `signatureNames` = base sortables ∪ every handle's sortables.

**12c. runs**
- **core:** `RunRowSchema` (`runKey`, `kind`, `id`, `label`, `outcome`, `trigger`, `startedAt`, `finishedAt`,
  `duration`, `namespace`, `message`).
  - `liveCollection("runs", { arms: { discriminator: "kind" }, scroll: true, default: startedAt desc / 50, maxLimit: 200, … })`.
  - `runRowKey` uses `armKeyCodec`.
- **server:** `defineRunKind({ columns: handle, from, id: PgColumn, joins?, base(j), extra(j), where?(j) })` (T9).
  - `kind` is derived from the handle.
  - `duration = (extract(epoch from finished_at - started_at)*1000)::double precision`, which is NULL while running.
  - `runsServed = serveUnionCollection(runs, { arms: () => getRunKinds().map(toBinding) })`.
  - A boot assertion (`onDeferredResourcesBound`) checks that the handles are distinct by kind.
- **web:**
  - a module-level `liveDataSource(runs, { searchable })`;
  - `emptyState` is required (both callers already pass it);
  - `<RunDuration>` = `useNow(1000) − startedAt` while running, otherwise `duration`, with one formatter;
  - `useRun` = `useLiveRow(runs, runRowKey(ref))`;
  - `Runs.Kind` drops `fields`.

**12d. The four arms** (`build`, `release`, `deploy`, `backup` `runs-arm`)
- core: `liveArmColumns(...)` replaces `defineRunArmFields`.
- server: `defineRunKind`; the label and outcome CASEs become `ExprField`s.
- **deploy:**
  - `lookup("server", _deployServers, on base.serverId, required: false)`;
  - label = `expr(compositionId || ' on ' || coalesce(server.name, serverId))`;
  - a rename ⇒ the reverse `deploy.server` ⇒ a scoped refill.
- **backup:** a provenance test asserts that the route columns are exactly `{id, trigger, started_at, finished_at,
  status, archive_size_bytes, manifest, target_results}`, and that a pid-only UPDATE gives zero loads.

**12e. Backup panes**
- `useResolveBackupRun = resolveRow(useRun(…))`.
- The body renders `rowOrStale(state)`: a ready-and-found row, else an error's stale row, else `<Loading/>`. Add the
  helper beside `resolveRow` (`primitives/pane/web/resolve.ts:53-63`).

**12f. Deletions**
- **runs:** `runs.revision`, `queryRuns` / `getRun`, `handle-query.ts`, `handle-get.ts`, `query-defaults.ts`,
  `arms.ts`, `arm-value.ts`, `arm-fields.ts` (core and web), `RUN_COLUMN_DOMAINS`, `UnionRunSchema`.
- **The whole `data-view/plugins/union-query` plugin**, with its bun.lock entries.
- **Lint:** the lines at `:128-132`.
- **Docs:** runs, the four arms, query-resource, network/live, keyset, data-view and server-query CLAUDE.md; the
  comment at `backup-panel.tsx:108`.

**Tests**
- `routes.test` (prefixing, encode, the reverse wrap, raw ids containing `:`, T10).
- `compile-union-window.test`: the shapes, pruning, static nullability with a pruned tuple, zero arms, the A14
  throws.
- The live-columns owner switch and A16.
- **The `serve-union` oracle with real triggers.** It drives:
  - arm-`where` flips;
  - pid / `leg_run_id` writes (zero loads);
  - a server rename under and over 500;
  - retention and cascade deletes;
  - running → finished;
  - kind-pruned tuples.

  At quiescence every view equals a fresh FULL.
- jsdom: `RunsDataView`, `RunDuration` on the pinned clock.
- e2e `runs/e2e/runs-live.ts`.

## P7: conversation lists (step 13; needs step 7)

**13a. `tasks-core/server/internal/conversation-owner.ts`**
- `conversationOwnerJoins`:
  - an `attempt` lookup on `base.attemptId`, required;
  - a `task` lookup on `attempt.taskId`, required.
- `conversationOwnerColumns = { worktreePath, taskId, taskTitle }`.
- The INNER joins are lossless (NOT NULL cascade FKs).
- Export `ColumnOverride` and `DefaultScope` as types from `network/live/server`.
- Exported from the tasks-core server barrel; reused by P8.

**13b. Collections (`all-conversations/core`)**
- `ConversationListRowSchema = ConversationSchema.pick({ id, title, status, model, kind, runtime, spawnedBy,
  createdAt, updatedAt, endedAt, worktreePath, taskId, taskTitle })`. Poller writes (`waitingFor`, `lastViewedAt`)
  fall outside the gate.
- Two literal `liveCollection` calls share `CONVERSATION_LIST_*` consts (default `createdAt desc` / 100,
  `maxLimit: 500`, scroll):

  | Key | `columnScope` |
  |---|---|
  | `conversations.all` | `"all-conversations"` |
  | `conversations.history` | `"conversations-sidebar"` |

- The **`taskTitle` field is added**:
  - a `FieldSpec` and `liveText()`;
  - it joins SEARCHABLE;
  - `updatedAt` becomes sortable.
- `CONVERSATION_FIELDS` is `as const satisfies …`, and a test asserts that its sortable ids equal
  `CONVERSATION_SORTABLE`. A mismatch would otherwise throw at mount on both surfaces (`live-fields.ts:120-127`).

**13c. Serve**
- `conversations.all` gets `defaults: [{ unless: "kind", where: kind <> 'system' }]`. `defaults` already exists
  (`serve-collection.ts:190-216`).
- History has no default.
- Delete:
  - `handle-query.ts`, `column-map.ts`, `revision-resource.ts`;
  - `endpoints.ts` / `resources.ts` in core;
  - the imports and route at `plugins/conversations/server/index.ts:50-51, 101`.
- **Routes (verified in the oracle):**

  | Table | Route | Gate |
  |---|---|---|
  | `conversations` | identity | 13 columns + `attempt_id` |
  | `attempts` | reverse on the PK | `{id, task_id, worktree_path}` |
  | `tasks` | reverse through `attempts` | `{id, title}` |
  | the custom family | its route | — |

- The task relation is in the **membership** role, with moves `{id}` (plus `title` when the tuple's where names
  `taskTitle`). A title-only UPDATE is therefore a **scoped value refill** of that task's member ids ∩ the window;
  searching tuples get a membership refill.

**13d. Web**
- `fields.tsx` and `StatusCell` retype to `ConversationListRow`.
- **All pane:** `source = liveDataSource(allConversations, …)`, with no `rowKey`.
- **History:** `source` in the merged sidebar DataView. `HistoryItemActions` and `CloseConvAction`
  (`sidebar-history.tsx:31,43-45`) retype to `ConversationListRow`.
- `sidebar-conversation-item` takes `ConversationItemConv & { taskId; taskTitle }`.
- No `column` refs on `conversationFieldDefs` (the in-memory Queue reuses them).
- Delete lint lines `:109-114`. Update the plugin descriptions.

**13e. Tests**
- **The DB oracle.** It drives:
  - insert, update, delete;
  - a poller write (zero loads);
  - a rename (value refill vs membership refill);
  - a worktree change;
  - an attempt moved between tasks;
  - a task-delete cascade;
  - a system status flip (it reaches History, not All's default).

  Plus C1, C2 and C3.
- A unit test of the `unless` drop.
- jsdom `merged-live-source.test.tsx`.
- e2e `list-live-verify` and `history-live-verify`:
  - seed reactor-inert rows: status `done` with `ended_at` set, `titleAuto=false`;
  - rename through the **real** task-rename endpoint (so `tasks.titleChanged` fires);
  - clean up by deleting the task.
- **Measure trigger time** on conversations, attempts and tasks before and after. These are their first routed
  layouts.

## Step 14: I7d (needs steps 5, **8**, 12 and 13)

**Delete**
- data-view core:
  - `ServerPage`, `ServerDataSourceSpec`, `DataViewFetchPageOrigin` (`types.ts:1092-1153, 1246-1258, 1280`);
  - `dataSource?: never`;
  - `ServerFilterWireSchema`.
- data-view web:
  - `use-server-data-source.ts` and its test;
  - in `data-view-body.tsx`: the server blocks, the `props.dataSource` clause (`:607`), `globalExtensionIds` and
    `NO_*`;
  - the `sourceScope` prop (`body-types.ts:95`, `merged-data-view.tsx:210`);
  - the `ServerDataSourceResult` export;
  - the fetchPage arms of `body-types.test.ts`.
- **The `data-view/plugins/server-query` plugin**, with bun.lock refreshed.
- custom-columns `query-augmentor.ts` and its wiring.
- `unwatchedFamily` (`serve-columns.ts:116-123, 190`).
- The keyset cursor codec (`cursor.ts`, `core/index.ts:2-3`).

**Rename**
- `server-filter.ts` → `live-filter.ts`. Delete `serverFilterFields`.
- Drop the dead `query` / `searchable` args, giving `lowerViewFilter` / `useViewFilter`.
- Importers: `live-source.ts`, `body-fallback.tsx`, `live-source.test.tsx:68`.

**Comments and docs**
- `data-view-body.tsx:167`, `mail/search/use-mail-search.ts:26`;
- `slots.ts`, `row-order.tsx` and `define-data-view-sources.tsx` docs;
- CLAUDE.md for data-view, custom-columns, keyset, sql-column, fields/text/storage and backup/runs-arm.

**A27 (whole, at this step)**
- The Item 7 group heading is deleted.
- An **AST callee-name** check pins bare `resourceDescriptor(` to `pagesResource` / `pageLinksResource`.
  `keyedResourceDescriptor` is a different name, tracked by Item 3.
- tsc guarantees no fetchPage symbol resolves (T17).

**Verify**
- `rg` finds no `ServerDataSourceSpec|changeTick|useServerDataSource|server-query|encodeCursor|unwatchedFamily`
  outside research and docs. cursor-pagination's own `fetchPage` is excluded.
- e2e `search-query-scope` and `control-panels`.

## ★ Step 15: review checkpoint (P6, P7, item 7)

At this checkpoint I also:
- append "as landed" to the parent doc, and fix its stale ":108 uncommitted" line;
- correct v1's drifted citations;
- record the trigger-time measurements for steps 7, 8, 12 and 13.

## P8 (steps 16–24)

### Step 16a: runtime and L2

**Runtime (`resource-runtime/core`)**
1. **Order signature on the alias.**
   - `scopedMembership: { orderOf, orderSignatureOf }`, threaded through `MembershipRecord` (`:225`) and
     `buildEntry` (`:3046-3053`).
   - The unbounded branch (`:4435-4453`) runs `orderOf` on `entered || orderMoved`.
2. **Definition (A18).**
   - `RoutePlanInput.definition`; `RegistryEntry.definition`.
   - `persistedDefinitions()` sits beside `persistedKeys()` (`:6759`) and is re-exported by the server-core facade.
3. **Persist modes (A19).** The `persistSnapshot` hook takes `{ mode: "replace" | "floor"; definition }`.
   - **Full drains** replace (with the flight watermark) and cancel any armed trailing persist.
   - **Scoped drains** call `markPersistDirty`:
     - a fixed 2 s window, armed on the first drain, unref'd;
     - the floor is the BigInt-min of the drains' watermarks;
     - **an undefined watermark poisons the window**: it only LEAST-updates an existing row, and never writes one;
     - a key refused by A6 is never armed;
     - on fire, it reconstructs from `snapshotOwner` exactly as `:4510-4525` does today;
     - a pending window is dropped on shutdown.

**L2 (`live-state-snapshot`)**
- **`tables-ddl.ts`:** idempotent `ADD COLUMN IF NOT EXISTS definition text` and `position_at timestamptz`.
  - `position_at` advances only on a replace persist; `persisted_at` advances on every write. Both are needed.
  - No drizzle migration: the DDL is imperative (`tables-ddl.ts:11-25`).
- **Upsert:**
  - a floor persist writes `position = LEAST(stored, W)` and keeps `position_at`;
  - a replace persist writes `W` and `now()`;
  - every persist sets `definition`.
- **A18 as a read predicate (blocker fix).**
  - `readPersistedSnapshots`, `readPersistedReadSets` (the onReady usability check) and `handle-boot-snapshot.ts:84`
    all match `definition IS NOT DISTINCT FROM $expected[key]`.
  - A mismatch counts as no usable row ⇒ `recomputeResource` / the loader.
  - The onReadyBlocking DELETE stays, as cleanup only.
  - Test: a row written *after* the sweep with a different definition is neither seeded nor served.
- **Boot snapshot for a persisted alias** serves the in-memory kept `{}` snapshot once loaded, because L2 lags by up
  to 2 s. It falls back to L2 only before the first load.
- **Compact job** `live-state-snapshot.compact`:
  - hourly, per worktree, singleton;
  - recomputes **every** persisted key whose `position_at` is more than 1 h old. The floor is global
    (`prune.ts:37-41`, `catch-up.ts:118-130`).
  - It runs in the serving backend (check job placement; `recomputeResource` is in-process).
  - The Read-set pane shows `position_at` age.
- **Catch-up backstop:** when oldest retained xid > floor, `recomputeResource` every persisted key and skip L2
  seeding. `fullRecomputeChangedTables` only sees tables still in the changelog, so on its own it is not complete.
- **The A6 guard** forwards the new argument.

### Step 16b: the compiler (the `all` arm, compile-alias, grouped joins, rollups as data)

**API**
- **`liveCollection(key, { row, id, all: { orderBy, unbounded: { reason } }, preload? })`** mints `key` (param-less,
  the whole ordered set) and `key:rows`. No `:groups`.
  - Window and lookup keys are `never` (T13).
  - Runtime throws: an empty reason, an empty `orderBy`, a non-row field. `preload: "none"` counts as absent.
- **Descriptor:** `allResourceDescriptor` has no `defaultParams` and no `initialData`; any param fails
  `validateParams`.
- **`useLive(all)` → `ResourceResult<Row[]>`; `useLive(all, { select })` → `ResourceResult<S>`.**
  - Both read straight through `useResource` with no row map, so the array keeps its identity per snapshot (the
    TaskGraph WeakMap at `tasks/web/client.ts:63-71` relies on that).
  - The gate is always on. Its `settledKey` latch starts from the cache, so a hydrated read renders once.
  - `useLiveRow(all, id)` reads `:rows`.
- **Entry point:** a third overload of `windowQueryResource` / `deferredWindowQueryResource` (no new register
  marker). `serveCollection` binds an `all` collection eagerly; it cannot be contributed.
- **Join kinds** (`query-resource/core/internal/joins.ts`):
  - `rollup`: `on` = base pk, **or a non-PK base column**;
  - `children`: `on` = base pk, `fk`, with `aggregate(render, { decoder, sqlType, ifNone })` and
    `jsonAgg(cols, { orderBy })`, whose `ifNone` is `'[]'`;
  - `closure`: `edges`, `child`, `parent`, `ancestorJoins`.

  Notes:
  - For children and closure, `JoinRefs` exposes **only** aggregates. A raw child column is a tsc error.
  - `ifNone` is required on a non-nullable aggregate (A33).
  - Children and closure are allowed only in mode `all` (A24).
  - `readExpressions` gains `{kind:"aggregate"}`.
- **Rollups become data (`derived-tables`).** `defineRollup({ table, key, columns, sources: [{ table, carry, via?, reads }] })`
  generates:
  - a maintain function **per source**, which fixes `task_latest_conversation` firing from attempts;
  - the reconcile (D21: `diff AS (agg LEFT JOIN t … WHERE t.k IS NULL OR ROW(…) IS DISTINCT FROM ROW(…))`, then
    upsert only the diff, RETURNING counts) and `reconciledRollups()`.

  Also:
  - Maintain takes `pg_advisory_xact_lock` per key in sorted order, then aggregates in a fresh statement (A34).
  - `CREATE TABLE` still interpolates the table constant (the `imperative-create-table-allowlisted` check).
  - The three existing rollups convert with byte-equivalent aggregates.
  - The opaque `DerivedRollupSpec` arm and `joinRoute` are deleted (replaced by `joinRoutes`).

**SQL shapes (`compile-alias.ts`, `grouped.ts`)**

All shapes run through `QueryDb.execute` + `decodedRow`. CTE names are unquoted and match `/^__[a-z0-9_]{1,60}$/`
(A38); a quoted name would land in every captured read-set (`database/server/internal/client.ts:201`).

| Shape | SQL | Measured |
|---|---|---|
| **Full** | Set-based `GROUP BY` CTEs plus one recursive closure (`UNION`, so a cycle terminates), hash LEFT JOINed to the base, `ORDER BY orderBy, pk`. Every grouped output is read as `COALESCE(out, ifNone)`. | tasks **31–35 ms** (parity 0/0); attempts 29–32 ms |
| **Scoped** | The same CTEs filtered `= ANY($ids::text[])`. The recursion is a `CROSS JOIN LATERAL (… OFFSET 0)`; ancestor groups are filtered by an `ANY(ARRAY(SELECT DISTINCT anc …))` InitPlan; the ancestor base row is reached through a pk lateral. No ORDER BY. The planner fences are pinned in the text (A32). | 1 id: 3.45 ms + 3.8 ms plan; 25 ids: 7.5 ms; 75 ids: 14–20 ms |
| **orderIds** | `SELECT pk FROM base <INNER joins + joins its where reads> WHERE … ORDER BY …, pk` | 5.5 ms |
| **Dependents probe** | An `OFFSET 0` lateral on `task_deps_depends_on_idx`, `LIMIT cap+1`. `within` goes into SQL only when it has ≤ 256 ids; otherwise it is filtered in JS. | 0.74 ms |
| **jsonAgg children** | timestamptz renders as `to_char(col AT TIME ZONE 'UTC', '…"Z"')`. A timestamp-without-time-zone child is refused. Allowed child types: text, boolean, integer, timestamptz, json, jsonb, text[]; no `withWire` (A39). | — |

**Routes emitted**

| Join | Route | Gate |
|---|---|---|
| rollup, `on` = base pk | `<a>[<src>]` = alias(carry), or reverse through `via` | `src.reads` |
| rollup, `on` = non-PK column | `<a>[<src>]` = reverse `[via] → base.on → base.pk` (1.1 ms) | `src.reads` |
| children | `<a>` = alias(fk) | fk, the child PK, the where reads, the aggregate reads |
| rollup inside children | `<a>.<r>[<src>]` = reverse `[via] → child.pk → fk` | `src.reads` |
| closure | `<a>` = alias(child) and `<a>:closure` (the dependents expansion) | child, parent, edge reads |
| provenance P under a closure | `<P.id>:closure` = P's probe, then its dependents | only the columns the closure reads on P |

- `task_dependencies` routes carry `column: "task_id"`: its PK is composite, so `ids` is null.
- No route names a rollup table (A1). `derivedReads` go to `mintRoutePlan`, and A8 accepts a captured rollup read
  whose sources are all routed (A22).
- **Fingerprint (A18)** = sha256 over:
  - the full, scoped-template and orderIds SQL and params;
  - the projection decoder ids;
  - `describeZod(row)`;
  - the wire codec ids;
  - each rollup's DDL hash;
  - `orderBy`.

  It is computed at bind and must be equal across two fresh processes (A40).
- **A30:** a persisted alias's L2 value is `safeParse`d against `z.array(row)` before seeding. On failure it is
  treated as missing.

**Sub-steps (each buildable)**
1. Shared:
   - `anyOf` moves to `sql-any.ts`;
   - `quotedRelationsIn(sql)` is a pure export of `database/server`;
   - the `readExpressions` union.

   The golden stays byte-identical.
2. derived-tables: `defineRollup` with generated maintain and reconcile, A34, `reconciledRollups()`, A21a/c; convert
   the three rollups.
3. Core: the `all` arm, the descriptor, `aggregate` / `jsonAgg` and the join types; the scanner `mintsOf` with depth-0
   presence (A28: one helper used by **both** `parse-resources` and `eager-tier-gen`, which today ignores `requires`).
4. Server joins: `rollup`, `joinRoutes`, `probeMap`; A24, A35, A36, A37; `derivedReads`.
5. `grouped.ts` and `compile-alias`: render, assemble, fingerprint; the overload; unit and golden tests.
6. The `serveCollection` `all` branch, with fixture-DB oracles (needs 16a and A30).
7. The `useLive` overloads and the latch fix.
8. Docs: network/live, query-resource, resource-vocabulary and derived-tables CLAUDE.md.

**Tests**
- T13 type tests.
- jsdom `use-live-all`:
  - a hydrated read renders once;
  - `data` keeps its identity with no push;
  - a delta keeps untouched rows' identity;
  - an unrelated push does not re-render a select;
  - an `order` delta reorders.
- Fingerprint stability and sensitivity.
- `define-rollup` oracle:
  - a non-read update leaves `xmin` unchanged;
  - a cascade-delete refresh;
  - heal counts;
  - a clean reconcile writes 0 rows.
- A two-connection concurrency oracle (A34).
- A closure property test of about 200 statements over a cyclic graph (A23).
- Full ≡ `tasks_v` / `attempts_v`, and scoped(S) ≡ full∩S, under `SET TIME ZONE 'Europe/Paris'`.
- A runtime oracle:
  - insert = entrant; delete or where flip = exit;
  - an order move ⇒ one `orderOf`; a value-only update ⇒ none;
  - an idle `{}` snapshot stays current.
- A28 cross-check: the runtime-minted keys equal the `parse-resources` output for every arm.

### ★ Step 17: benchmark gate

Run on a main fork. Present:
- compiled `tasks` full vs `tasks_v` (expected about 0.45×: passes);
- `attempts` full (D11);
- scoped closure p50 / p95 / max (D12);
- order-frame bytes (D13);
- cold boot with the L2 rows swept;
- closure pair count (12,115 today).

Stop for your review.

### Steps 18–22: the conversions (A5 holds at every step; no other `dependsOn`, `edges` or `recomputeOn` names a tree key)

| Step | Resource | Notes |
|---|---|---|
| 18 | `task-categories` | <ul><li>`all`, `orderBy taskId`, preload boot</li><li>identity on `tasks_ext_category`</li><li>`useTaskCategoryMap` → `ResourceResult` of a frozen record; update `category-field.tsx:20` and `task-dependencies.tsx:53`</li><li>remove the `task-category/web/index.ts:6-9` re-exports</li></ul> |
| 19 | `tasks` | <ul><li>`attempt_conv_agg.has_waiting_conv` (rollup data; heals once at boot)</li><li>shared builders `attemptDerived` / `taskDerived` / `depIsBlocking` in `tasks-core/server/internal/derived.ts`; rebuild `attempts_v`, `task_blocking_v` and `tasks_v` on them, so `tasks_v` no longer reads `pushes` or `conversations` (`views.test.ts` stays green)</li><li>joins: `children(att)` with the two rollups; `children(deps)` → `dependencies`; `closure(blocking)`</li><li>`taskDescriptions`, a lookup-only `{id, description}`; the prompt seed = `{...row, description}`; the `getTask` refetch (`task-description.tsx:45-50`) is unchanged</li><li>a description autosave is a one-row refill through `updated_at` (accepted)</li><li>every `tasks` reader moves to `useLive(tasks[, {select}])`</li></ul> |
| 20 | `attempts` | <ul><li>rollups conv and push; `children(convs, where kind <> 'system')` → `conversations: jsonAgg(id, title, status, kind, createdAt, spawnedBy; createdAt asc)`</li><li>routes: alias(`attempt_id`) on conversations and pushes. **Fixes C1.** The gate replaces `TRANSIENT_CONVERSATION_FIELDS`.</li><li>delete `pushesAttemptsCascade`, `listPushes` (with its barrel line), `listConversationSummariesByAttempt` and the carrier</li><li>doc sweep: `docs/tasks-model.md:124-138`, `tasks-core/web/internal/register.ts:1-19`</li></ul> |
| 21 | `agent-launches` | <ul><li>`task_latest_conversation` gains an `attempts` source (AFTER DELETE / UPDATE OF `task_id`; fixes the cascade-delete staleness). Lands together with the resource (A35).</li><li>`rollup(latest, on base.taskId)` ⇒ reverse routes: `attempts.task_id → launches`, and `conversations → attempts.task_id → launches`</li><li>nested `latestConversation` as an ExprField (D18)</li><li>remove the `agents/web/index.ts:27` re-export</li><li>a seq scan on 29 rows; no index added</li></ul> |
| 22 | `conversations-active` / `-system`, then `-gone` | <ul><li>`all` over `_conversations` + the owner joins; `active` as an ExprField; `where` is membership</li><li>`waitingFor` is a one-row identity refill</li><li>`debounceMs` dropped (D16)</li><li>`-gone` is a window (`filterable`, `sortable: [endedAt]`, `RECENT_GONE_LIMIT`, preload), so it leaves L2</li><li>`useConversation` → `conversations.by-id` (D17); `recovery-view.tsx:59` likewise</li><li>`conversationsGoneStats` re-pointed at `_conversations`</li><li>delete `conversationCascadeSignatures` and `TRANSIENT_CONVERSATION_FIELDS`</li></ul> |

Each step:
- deletes its "· <key>" lint lines;
- adds its parity and oracle cases to the **tree oracle** (80 steps over tasks, edges, attempts, conversations and
  pushes; depth 4 and over cap; the L2 crash, fingerprint and heal cases);
- measures trigger time on the tables whose layout changed.

### Step 23: S6 deletions (needs steps 5, 8, 12, 13 and 22)

**runtime**
- **ScopePolicy keeps only the two routed arms (T14).** This deletes:
  - the `identityTable`, `recompute` and `fanOut` arms;
  - `DefineResourceInput.identityTable` and the `contractToDefinition` fields;
  - `derivedIdentityTable`.
- **`DependsOnEntry.resource: ExternalResource`, with a buildEntry throw (T15).** Every current upstream is external:
  `refHeadServed`, `editedFilesServed`, `savedIconsChangedServed`, `configValues`, `customColumnDefs`.
- **DownstreamEdge** loses `affectedMap`, `signature` and `lastSignatures`; `SKIP_EDGE` goes.
- **A25** gets an explicit throw. Then delete the drain cascades (`:4217-4225`, `:4466-4478`).
- **Delete** `coveredOriginsFor`.
- **`applyDbChange` → `applyLegacyFullChange({ table, source, xid?, changedAt? })`.** This deletes:
  - the identity-origin scoping;
  - the secondary-view dedup;
  - the edge-covered `continue`;
  - the legacy point intersection.
- **`setRelationBases(fn, version)`** replaces `setRelationResolver` and `setFeedExemptTables`.
  - It expands views transitively and maps rollups to their `sources`, at inversion time (so L2-seeded read-sets
    resolve).
  - Its version is folded into the `tableToResources` memo.
- Delete `Resource.notify`'s `affectedIds` option and the non-membership scoped drain branch. **`LoaderCtx.affectedIds`
  stays.**

**change-feed**
- `routeChange` = `routeTableChange` + `applyLegacyFullChange`.
- Delete the `dependentViews` loop and the `relationIdentityBase` import.
- `view-deps.ts` exports `relationBases`.

**derived-views:** delete `relation-identity.ts`, `View.identityTable` and the three uses in
`tasks-core/server/index.ts:243-250`.

**query-resource**
- Delete:
  - `rel.ts` and `compile.ts` (`compileQuery`, `compileEdges`, `queryResource`);
  - the Edge / Hop / QueryResourceSpec parts of `spec.ts`;
  - `queryResourceDescriptor`;
  - `compile.test` and `compile-runtime.test`.
- Keep `identity.ts`.

**live-state:** delete `keyedResourceDescriptor`.

**resource-vocabulary:** delete the `keyedResourceDescriptor` / `queryResourceDescriptor` entries and the
`queryResource` marker (`vocabulary.ts:216-225, 276-283`) with their `parse-resources` fixtures.

**keyed-resource-scope check:** flags any `identityTable` key; routes ⇒ exactly one of `membership` /
`scopedMembership`.

**live lint:** delete the Item 3 tree entries. The page entries are already in the D20 group.

**Tests to migrate onto minted routed fixtures**
- About 15 resource-runtime suites, plus `runtime-tracking-span` and `runtime-table-routing`.
- change-feed: `route-change` and its siblings.
- query-resource.
- network/live: `serve-collection`, `serve-value`, `compile-window`, `compile-window-runtime`.
- `runtime-profiler/install`, `page-doc-order`, `parse-resources`, `produced-guard`.
- Delete the coveredOrigins, edge and affectedMap suites.

**Docs and comments**
- The hand-written CLAUDE.md of read-set, network/live, change-feed, resource-runtime, server-core,
  keyed-resource-scope, live-state, tasks-core and query-resource.
- `live-state/CLAUDE.md:443`.
- The `applyDbChange` mentions in `server-core/core/read-set.ts:3`, `listener.ts:151`, `route-span.ts:13`,
  `triggers.ts:649`, `boot-init.ts:28` and `catch-up.ts:55,106,149,183`.

### ★ Step 24: A7 pane honesty and A26; final review

- **`_debug` per entry:**
  - `policy: routed | external | legacy-full`;
  - `persisted`, `definition`, `derivedReads`, `tuples`, `position_at` age;
  - `readSetBases` through `relationBases`, no longer filtered.

  `identityTable`, `recompute` and `coveredOrigins` are dropped. `dependsOn` / `downstream` stay (live-state-health
  reads them).
- **`computeCeiling`** lists:
  - `legacyFull`: every legacy-full entry, with its bases, tuples and persisted flag;
  - `routedFull`: each routed `full` route, with its reason;
  - `drift`.

  Delete Section C.
- **A26:** every registry entry appears in `_debug` with a policy (a runtime test); a jsdom test of `computeCeiling`.

## Build sequence

| # | Step | Phase |
|---|---|---|
| 7 | `reverse.column?` | shared |
| 8 | 8.0 I7p, then I7a / I7b / I7c in any order (each removes its own lint lines) | item 7 |
| 9 | ArmPlan contract and the compile-window / compile-groups split. **Byte-identical golden; lands alone.** | shared |
| 10 | `ExprField`; `QueryDb.execute` + `decodedRow` | shared |
| 11 | `RawRoute`, `armKeyCodec`, `compiledUnionRoutePlan`; owner-discriminated handles; the `arms` overload; register markers | P6 |
| 12 | `compile-union-window`, `serve-union` (deferred), runs and the four arms, web; delete `runs.revision` and **union-query** | P6 |
| 13 | conversation owner joins; two collections; web; delete `conversations-revision` | P7 |
| 14 | I7d; A27 | item 7 |
| 15 ★ | Review: P6, P7, item 7 | — |
| 16a | Runtime alias signature + `orderMoved`; definition; persist modes; L2 columns, the read-predicate A18, the compact job (all persisted keys), the backstop | P8 |
| 16b | The compiler: sub-steps 1–8 above | P8 |
| 17 ★ | Benchmark gate | P8 |
| 18 | `task-categories` | P8 |
| 19 | `tasks` (`has_waiting_conv`, shared builders, views rebuilt, `taskDescriptions`) | P8 |
| 20 | `attempts`; delete the carrier | P8 |
| 21 | `agent-launches` + the `task_latest_conversation` attempts source | P8 |
| 22 | `conversations-active` / `-system`, `-gone`, `conversations.by-id` | P8 |
| 23 | S6 deletions | P8 |
| 24 ★ | A7 pane and A26; final review | P8 |

**Hard orderings**
- Step 9 lands alone, before any union code.
- 7 → 13.
- 14 needs 5, 8 (all of it), 12 and 13.
- 16a → 16b.6.
- Step 21 is atomic with its rollup source (A35).
- 22 needs 19–21.
- 23 needs 5, 8, 12, 13 and 22.

**Every step** ends with `./equin build` green (`check` included) and `./equin test` over the touched
plugins.

## New assertions (in addition to v1's table)

| ID | Rule | Rung |
|---|---|---|
| A29 | `all.orderBy` binds only base columns; orderIds includes every INNER join | bind |
| A30 | A persisted alias's L2 value parses against `z.array(row)`, else it is treated as missing | runtime |
| A31 | `decodedRow` requires the exact key set | runtime |
| A32 | Scoped-closure planner fences are pinned in the SQL text | unit |
| A33 | A non-nullable aggregate declares `ifNone` | type |
| A34 | Rollup maintain takes per-key advisory locks in sorted order, then a fresh-snapshot aggregate | generated SQL + oracle |
| A35 | Each reverse-probe hop table has a non-full route whose gate covers the hop columns | bind |
| A36 | Every table with a column-carrying route has the routed trigger carrying that column | boot |
| A37 | `closure.child` / `parent` and `children.fk` each lead an index or the PK | boot |
| A38 | CTE names are unquoted and match the validator | bind |
| A39 | jsonAgg child types are limited to the allowed set; no `withWire` | bind |
| A40 | The definition is deterministic across processes; no non-literal JS params in `all` SQL | test + bind |

**Revised from v1**

| ID | Revision |
|---|---|
| A18 | A read predicate on every L2 read path, not only a sweep. |
| A20 | The reconcile heal count feeds `reconciledRollups()`, asserted before L2 onReady. |
| A21 | Generated per source. |
| A27 | Whole at step 14, as an AST callee check. |
| A28 | One `mintsOf` helper, plus a runtime-vs-scanner cross-check. |

## Verification

- **Per step:** a backgrounded `./equin build` + `await`; `check` (type-check, boundaries,
  `plugins-doc-in-sync`, `resource-runtime:compiled-routes`, A11 / A27 / A28 / A36); `./equin test` over the
  touched plugins.
- **Oracles (real triggers; at quiescence every client view equals a fresh FULL):**
  - serve-union;
  - conversations collections (C1–C3);
  - events source-runs;
  - release history limit 1;
  - the tree oracle (80 steps, parity, L2 crash / fingerprint / heal / hot-swap row);
  - define-rollup;
  - A34 concurrency;
  - the A23 closure property test.
- **E2E** (each refuses main; seeds and cleans its own rows; reactor-inert seeds):
  - `runs-live`;
  - `list-live-verify`, `history-live-verify`;
  - events `runs-live-verify` (+ a custom-column sort);
  - `release-info-live-verify`, `summary-live-verify`;
  - `tasks-core/e2e/tree-live-verify.ts`: a status flip updates attempt and task; a push completes A and unblocks B;
    a rename updates `conversations-active.taskTitle`; a drag reorders; a reload's first paint is live;
  - data-view `search-query-scope` / `control-panels` after step 14.
- **`get_runtime_profile` over each e2e:**
  - **gone:** the seven tick and carrier keys, and the `/api/{runs,reports,conversations}/query` requests;
  - **push loads are scoped:** `ids` ≤ changed + dependents;
  - **zero loads** on list and tree keys for writes to `pid`, `rank` (except one `orderOf`), `lastViewedAt` and
    `waitingFor` (except the one-row `conversations-active` refill);
  - persist spans ≤ 1 per key per 2 s;
  - closure spans within D12;
  - no subscribed `runs:groups` (D23);
  - **no FULL** outside boot, compaction, over-cap and declared legacy-full entries.
- **Final audit:** `rg` finds no `rel(`, `identityTable`, `compileEdges`, `ServerDataSourceSpec` or `changeTick`
  outside docs. The Item 3 tree entries and the Item 7 group are gone. The A7 pane lists every legacy-full entry.

## Risks (ranked)

1. **Steps 16a/16b are new and broad.** A wrong L2 position or definition means a stale first paint on every page
   load. Mitigations: A18 as a read predicate, A19, A30, the hot-swap test, the backstop recompute and the crash-case
   oracle.
2. **Planner-fence regressions on the scoped closure.** They are pinned in text (A32), but a Postgres upgrade can
   change plans. Re-measured at ★17. The closure pair count (12,115 from 1,807 edges) grows faster than the graph.
3. **The step-9 split** is read by every `serveCollection`. Mitigation: the byte-identical golden plus every oracle.
4. **Trigger and maintain-function rebuilds on hot tables** across steps 7, 8, 12, 13, 16b.2 and 19–22. Each is a
   boot lock window; trigger time is measured per step.
5. **Silent route degradation**, if a routed trigger lacks a carried column. A36 makes it a boot error.
6. **Order-frame size** (D13), and the always-on gate rendering a few extra times on a cold mount.
7. **The shared builders change the text of `tasks_v` / `attempts_v`,** which 48 files read. Covered by
   `views.test.ts` and parity.
8. **Test churn at step 23.** Budget a dedicated migration pass.
9. **Volatile reports and reverse-cap FULLs.** As v1.

## Known limits after this task

v1's list, plus:
- **D22:** persisted `serveValue(db)` values may serve a stale L2 value after a loader change, for at most an hour
  (compaction).
- **D13:** order frames carry the full id order. An order-patch frame is a follow-up task.
- **Rollup-source gates use the whole `src.reads`.** So a write to a source column a reader never uses still routes:
  sound, but wider than needed.

## Provenance

1. **Remap (13 agents).** Six area readers verified every v1 claim at HEAD `3f7fe72db4` and re-derived each step's
   design; an adversarial reviewer per area; a completeness critic.
2. **16b design (7 agents).** Three sub-area designers (`all` arm, compile-alias SQL, join kinds and rollups) with
   `query_db` prototypes on main; an adversarial reviewer each; one synthesis.
3. **Accepted review findings are folded in above.** Each was checked against the code; the "What v2 changes" section
   lists the load-bearing ones.

## As landed: steps 7–14 (2026-10-03, uncommitted, awaiting the ★15 review)

Every step was implemented by an Opus agent, reviewed adversarially and fixed. Each one ended with
`./equin build` green (checks included) and the touched plugins' tests passing. The last deploy is build
`3f7fe72db4-1790981204107`.

Deviations from the text above:

| Step | Deviation |
|---|---|
| 7 | The change-feed `server/testing` barrel re-exports `readInstalledTriggers` / `installedLayouts`, so the lookup oracle can read the installed layout back. |
| 8.0 | **The refusal walk recurses into nested schemas.** The declaration walk visits every zod schema in `_def` (a `ZodEffects` hidden under `optional` / `pipe` / a union is caught). It also refuses `ZodString` `.trim()` / `.toLowerCase()` / `.toUpperCase()`. An empty record throws.<br>**Narrower than the plan.** `preload` is `never` on typed params. A parsers record typed with an index signature is a tsc error. |
| 8.1 | The oracle follows the reports-list + scoped-oracle pattern; no "deploy run-history oracle" exists. The e2e's Refresh phase is a seeded ledger insert. |
| 8.2 | **D15 fired.** The 7d summary query measures about 337 ms on main, so `latency-ledger.summary` is `load: "on-demand"`, not pushed. The minute flush notifies subscribed windows (`flush-notifier.ts`).<br>**The no-db-backed-notify exemption is per call and per table.** A flagged call is exempt only when its arguments name a table its plugin excludes with a literal `ExcludeFromChangeFeed({ table })`. The latency-ledger exclusions were rewritten as four literal calls. `DB_ACCESS` also matches `executeRows(db` / `queryRows(db`. |
| 8.3 | **Types.** `ReleaseInfo` is `ResourceResult<ReleaseSnapshot>` (`no-platform` \| `resolved`), because the `no-handrolled-result` lint bans a hand-spelled union. The D14 gate is a `combineResources` input, and `candidatePredatesLatest` lives in remote-deploy core.<br>**Memo.** The candidate signature adds a per-(composition, platform) close epoch. `createGitStateMemo` / `SignedMemo.get` take `{ notBefore }`, so after a close a compute already in flight is superseded rather than joined (`candidate-observer.ts`). |
| 9 | **Where the golden lives.** The generator is `network/live/server/testing/gen-compile-golden.ts`, because test helpers cannot be imported from `scripts/`. The golden is compared byte-for-byte as text.<br>**The arm contract.** It is a union on `mode`. The arm's `fold` also writes `$key`, and throws if a part it reads was not projected. A window arm's `pointQuery` projects the key parts. |
| 10 | **Spelling.** A binding is `field: (j) => expr(sql…, opts)`, because tsc cannot infer `j` inside a nested generic. The `j` refs render the defaulted wire column, and `serverOnly` covers base columns only.<br>**Safety.** `ExprField` carries an unexported brand. `decodedRow` refuses NULL in a non-null field, and only decoders made by `nullable()` admit NULL. |
| 11 | **Placement.** `armKeySql` lives in `query-resource/server` (it needs the runtime `sql` tag).<br>**Typing.** T11 also covers column refs (`owner`, with an `own` arm). `serveCollection` refuses an arms collection by type.<br>**Moved.** The register marker moved to step 12. |
| 12 | **The union does not go through `planArm`.** It reuses only `routedReads` (exported, byte-identical) and `planGroupArm`, and renders its own SQL. `planArm`'s renders cannot take the `kind:raw` tie-break, constant order keys or positional NULL padding.<br>**Entry point.** One entry, `compileUnionCollection`, and one new marker, `serveUnionCollection`.<br>**Decoding.** Rows are decoded per arm.<br>**Typing.** `defineRunKind` bindings are typed per field (`TypedJoinRef`). Backup `status` is a CASE over its enum.<br>**Tests.** A real-Postgres oracle covers scroll cuts and paging across arms. The jsdom test mounts RunsDataView over a stubbed DataView.<br>**Not run.** The D23 `get_runtime_profile` check (no subscribed `runs:groups`). |
| 13 | **Files.** `allConversationsDefaults` is in its own `defaults.ts`. The empty "Item 7" lint heading was removed here, not in step 14.<br>**Tests.** The C1 test uses its own 520-row long-id seed and asserts a FULL. The e2e asserts that no HTTP read of the live resource happens after the first listing. |
| 14 | **Lint grouping (D20).** D20's permanent lint group was created here. The two `CollectFieldExtensions` passes are merged into one fold.<br>**A27 is a check, not a lint rule.** It is `live:legacy-descriptors-pinned`, an AST check that also catches namespace calls and escaped references.<br>**Not pinned.** The D20 group's membership; `lint/index.test.ts` checks its files against the disk. |

Not done at this checkpoint: the per-step trigger-time measurements (Risk 4), which no step recorded reliably, and
the correction of v1's drifted citations (this doc supersedes them).
