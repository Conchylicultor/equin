# Scoped change routing, P5–P8: reports, runs, conversations, the tree, and closing Resources item 7

## Context

Follow-up of [`2026-09-29-global-scoped-change-routing.md`](2026-09-29-global-scoped-change-routing.md) (the
"parent doc"). The parent doc landed P0–P4 in `c5c6433ce4`: `routeTableChange`; identity, alias and reverse routes;
joins; the routed trigger layout; and the `unchanged` gate. It deferred P5–P8 to **one follow-up task, filed after
approval** (parent doc :59, :1835). That task is `task-1790690356513-qh4e20`, filed 2026-09-29, and this worktree
(`att-1790872918-dtvc`) is its only attempt. Nothing earlier was skipped.

Four things are still wrong today, all verified at HEAD `0d0a6fa685`.

**Reports.** `reports` is opted out of the change feed. Its list is a `reports.revision` tick plus an HTTP refetch of
every loaded page. The retention sweep deletes rows and sends no signal.

**Runs.** The four arm tables reach `runs.revision` through the legacy uncovered branch. Every arm write is a FULL,
pid-only writes included. The tick also misses two changes:
- a `deploy_servers` rename (the deploy label reads it through a correlated subquery);
- retention deletes outside its 50-row fingerprint.

**Conversations.** The lists read `conversations_v`. A task rename or attempt write is forwarded as `op U, ids null`
(`change-feed/server/internal/route-change.ts:61-72`), which FULLs the tick. The tick's hash ignores titles, so
**renamed tasks never reach History**. The tick also hashes non-system rows only, so **History misses every status
change of a system conversation**.

**The tree and rel() edges.**
- **C1.** `pushesAttemptsCascade` (`tasks-core/server/internal/resources.ts:164-169`) has no `identityTable`, so every
  push write is a FULL of `attempts` and then of `tasks`. The comment at `:210-216` is wrong.
- **The `tasks_v` path.** `tasks_v` reads `pushes` directly (`views.ts:294-305`), so view forwarding FULLs `tasks` too.
- **Persisted entries reload in full.** `tasks`, `attempts`, `agent-launches` and `task-categories` are L2-persisted,
  non-membership entries, and `scoped = affected !== null && !persisted` (`runtime.ts:4815`). So **every change they
  receive reloads them in full**, and the "scoped" `rel()` edges save nothing.
- **Any DELETE cascades FULL** (`runtime.ts:4442`).
- **A latent lost update.** The edge-covered `continue` (`runtime.ts:6586-6590`) can drop delivery to a downstream
  whose upstream is a subscriber-less point. No production resource has that shape today, but the type allows it.

**Resources page item 7** ("fold the revision-tick lists into `useLive`") stays open until all of the above lands,
plus three ticks the parent doc did not list:
- `events.runs-revision`;
- `release.history-revision`;
- `latency-ledger.revision`;

and the deletion of the fetchPage DataView path.

**Outcome.**
- Every list and tree read above is a routed live resource whose writes cost O(changed).
- `reports.revision`, `runs.revision`, `conversations-revision`, `events.runs-revision`,
  `release.history-revision`, `latency-ledger.revision` and `pushes.attempts-cascade` are deleted.
- `rel()`, `coveredOriginsFor`, the edge-covered branch and view forwarding are deleted.
- The fetchPage DataView path is deleted.
- What still loads in full is a **declared** legacy-full path, listed honestly by the Read-set pane:
  `serveValue(source: "db")`, `pages` and `page-links`.

## Decisions

| Decision | Choice | By |
|---|---|---|
| P8 scope | **Full tree rewrite.** <ul><li>A routed persisted-alias compiler, including a nested 1:N projection (`attempts.conversations[]`).</li><li>Move `attempts`, `tasks`, `agent-launches`, `task-categories` and `conversations-active` / `-system` / `-gone` onto routes.</li><li>Delete `rel()` and every legacy branch except the uncovered one.</li><li>The uncovered branch survives as the named legacy-FULL path.</li></ul> | user, 2026-10-01 |
| Item 7 | **Closes in this task.** <ul><li>Also convert `events.runs-revision`, `release.history-revision` and `latency-ledger.revision`.</li><li>Delete the fetchPage DataView path.</li></ul> | user |
| Runs `duration` | **Finished-only.** <ul><li>Server: `finishedAt − startedAt`, NULL while running; sortable and filterable.</li><li>The cell shows a client-side elapsed ticker for running rows.</li></ul> | user |
| Deploy label | **Lift the P4 refusal.** Union routes encode a reverse answer and decode `within` per arm, so the label stays a lookup on `deploy_servers` and a rename updates live. | user |
| Reports producer | **Volatile, after commit.** No changelog and no NOTIFY. A6 forbids L2-persisted readers. | parent doc |

### Defaults taken by this plan (override at approval)

1. **Reports coalescing happens in the producer (2 s), not in a `serveCollection` debounce.**
   - The runtime debounce is not a rate cap: any flush drains it (`runtime.ts:3856-3866, 4567-4573`).
   - A source-side window caps a crash storm, and one setting covers the window, `:rows` and `:groups`.
   - This deviates from the parent doc's "the reports window keeps `debounceMs: 2000`".
2. **Rate-limited report writes emit too.**
   - The pane's count stays live during a burst; the bell stays quiet, as today.
   - The two disagree during a burst; this is documented.
3. **P7 makes `taskTitle` filterable and searchable.**
   - A rename is then a membership refill for searching tuples.
   - No `taskTitle` facet is declared: a facet over a joined text column would FULL on every rename.
4. **P8 compiles task blocking as a closure.**
   - It uses a scoped dependents expansion, about 2 ms of probe.
   - The alternative is a `full` route with a reason. That would cost a 67 ms, 5k-row reload on each of about
     368 status flips per 8 h.
5. **The L2 compaction job runs hourly on every namespace** (about 5 × 67 ms an hour).
6. **The events-runs "Caveats" field is display-only** (no sort or filter; no saved view uses it).
7. **A hand-run `./equin release` with the Deploy pane open** shows on the next HEAD advance, release completion
   or remount (`revalidate`). There is no file watcher.
8. **A11 (writes that bypass the producer) is a check, not a runtime SQL observer.**
   - The design pass proposed a connection-level write observer that parses every statement's write target. That is
     a per-query cost on the hot path, and a parse it misses is silent.
   - A static check is a higher rung and costs nothing at runtime. It flags any drizzle
     `insert` / `update` / `delete(<produced table>)` outside a `mutate` builder, and any raw-SQL write naming a
     produced table.
9. **Review checkpoints.** I stop for your review after step 6 (P5), step 15 (P6, P7 and item 7 done), step 17 (the
   benchmark verdict) and step 24 (P8 done). You push when you choose.

### Behaviour changes users will see

- All-conversations' Kind = System filter now returns system rows (system is a default, no longer a hard exclusion).
- History now updates on status changes of system conversations (a bug fix).
- Runs:
  - a running run sorts last by "Took";
  - `duration > X` no longer matches running runs;
  - the build/backup empty state is each caller's own copy (`hasRuns` is gone).
- Events run ledger:
  - it shows the full 30-day ledger via scroll instead of 50 rows;
  - search narrows to `error` and `outcome`.
- The release chip gains an error arm: a corrupt `RELEASE.json` is now visible instead of loading forever.
- The reports filter options update live, kept in alphabetical order.

## Design

### Shared primitives (used by several phases)

**`ExprField` (`query-resource/core/expr.ts`).** It is one expression primitive for every compiler:
- spelling: `expr((j) => sql\`…\`, { decoder, sqlType, notNull? })`;
- nullability is derived;
- provenance is read off the rendered SQL, like P2's route columns.

`serveCollection`'s `columns` accept `ColumnOverride | ExprField`. It replaces P6's ad-hoc `UnionExpr` and P8's
`expr`, and is what `active = status <> 'done'` and the run labels use.

**One window assembler over N arms (`compile-window.ts`).** The compiler is split in two:
- **`planArm(arm)`**: joins, provenance, `moves`, order keys, cuts and routes;
- **`assembleWindow(arms, outer)`**: signature guards, `$key`, and the full / scoped / ids / point loaders.

How the three compilers use it:
- **The single-table compiler** is the 1-arm case, and its SQL stays **byte-identical** (pinned by a snapshot plus
  every existing oracle). This split lands alone, before any union code.
- **The union window (P6)** is the same assembler over N arms.
- **The persisted alias (P8)** is the same assembler in mode `all`: no cut, no limit, ordered, `orderOf`.

`compile-groups.ts` splits the same way: `compileArmGroups(arms)`, with today's `compileGroupsQuery` as the 1-arm
case.

**`reverse.column` is optional (P7 §2.3, framework).**
- Today `reverseMap` always sets `column: pk.name` (`query-resource/server/internal/joins.ts:806`). The routed trigger
  then carries `ids` **and** `k.r` for the same values, which halves the 7000-byte payload cap for every reader of
  `tasks` and `attempts`.
- An absent `column` now means "the table's single-column PK, read from `change.ids`", as `identity` and `alias`
  already allow (`routing.ts:55-71`).
- Grep every reader of a reverse `column` before landing.

**`TableChange.source: ChangeSource` (`"feed" | "producer"`), required (T5).**
- `routeChange` takes a `RoutedChange`; the listener and catch-up pass `"feed"`.
- `deliverRouted` (`runtime.ts:6482`) and the legacy-full entry carry it.
- `NotifyStats` gains `producer`, and the Read-set pane gains a column for it.

**Typed `liveValue` params (I7p).** A `params` declaration may be a record of `ZodParser`s:
- `paramsGate` parses each one and throws `ResourceContractError` on failure;
- `useLive` and the loader are typed with the parsed values;
- the `string[]` form stays.

**Scanner support (A28).** `resource-vocabulary` and `parse-resources` learn the two new `liveCollection` arms,
`arms:` (P6) and `all:` (P8). Today a call with no `default:` is misread as lookup-only
(`vocabulary.ts:90-94, 231-248`). A test asserts that `plugins-details.md` lists every minted key.

### P5: the reports producer

**`defineChangeProducer`** lives in `database/plugins/change-feed/server/internal/producer.ts`, exported from the
change-feed barrel.

```ts
interface ChangeProducerSpec<T extends PgTable> {
  table: T;                                   // single-column PK (module-eval throw)
  durability: "volatile";
  reason: string;
  coalesce: { ms: number; reason: string } | "none";
}
interface ChangeProducer<T> {
  mutate<B extends ProducerBuilder<T>, R>(executor: NodePgDatabase,
    build: (q, table: T) => B, opts: { latency: "background" | "interactive"; returning?: R }): Promise<Rows>;
  declare: Contribution;
}
```

**The producer owns the write verb (rung 1).**
- `mutate` runs one insert / update / delete builder **on its own table** (T7). It appends `RETURNING pk` and emits
  exactly the returned PKs: insert and update become `U`, delete becomes `D`.
- There is no `emit` to forget or to misname.
- The executor is the pool type `NodePgDatabase`, so a caller's open transaction cannot host a producer write (T4).
  Each statement is autocommit, so the emit is after commit by construction.
- `latency` is required (T6). `interactive` flushes on resolve.

**Coalescing.**
- A pending `Map<id, U|D>`, last op wins.
- A fixed window: armed on the first change, never re-armed.
- The flush routes the `D`s, then the `U`s.
- `changedAt` is the earliest buffered emit.
- Over `PRODUCER_IDS_CAP = 1000` ids, the flush routes `ids: null` (one bounded FULL per tuple).
- Timers and flushes run in a root `AsyncLocalStorage.snapshot()` context. Otherwise
  `runInBackgroundLane(runWithoutProfiling)` would hide the `route` span and the flush cycle.

**Runtime guards.**
- **A12:** a producer that is not mounted throws.
- **A13:** `mutate` outside `bootMode === "serve"` throws. An exec child has no subscribers, so its emit would be lost.
  `worktree-cleanup/reap-job.ts:112` therefore moves to the outbox, like its sibling jobs.

**Test seam.** The change-feed testing barrel provides `mountProducersForTest` and `flushNow`.

**Change-feed integration.**
- The denylist gains `produced`.
- **A1′:** covered = triggered ∪ produced. Without it, A1 throws on a routed `reports` (`route-coverage.ts:89-101`).
- **A2′:**
  - one producer per table (module eval);
  - produced ∩ (excluded ∪ feed-exempt) = ∅ (boot);
  - no `live_state_notify*` trigger on a produced table (catalog read after `rebuildTriggers`).
- **A3p:** a route on a produced table carries no columns, because a producer emits ids only.
- The `exclusion.ts` prose stops recommending revision ticks.

**A6 (L2).**
- The runtime exposes `persistedKeys()` from its own `isPersisted`.
- Boot throws when a persisted key routes a produced table.
- A stale L2 row whose `tables_read` names a produced table is deleted and reported once, never thrown on.
- `persistSnapshot` refuses such a write; the key then becomes never-persist for the process, and this is reported
  once.

**A11 (check).** `change-feed:producer-writes` flags:
- a drizzle `insert` / `update` / `delete` on a produced table's binding outside a `mutate` builder callback;
- a `sql` / raw string writing a produced table's name.

Allowlisted, each with a reason: the migration runner and DB test fixtures.

**The reports writers.**

| Writer | Change |
|---|---|
| `recordReport` → `upsertReport` | Becomes `buildUpsert` + `mutate(…, { latency: "background" })`. The rate-limited path emits too (default 2); the bell write stays skipped. `shed` / `collapsed` write nothing and emit nothing. |
| `investigateReport` | `mutate`, `latency: "interactive"`. |
| `backfillNoiseClassification` | One `mutate` per flip; `flipped` is deleted. |
| Retention (`define-retention.ts:85-102`) | `sweepExpired` checks `changeProducerFor(table)`. With no producer (the 19 triggered callers), the code is byte-identical. With one, the delete runs through `mutate`, so the ids come from RETURNING. `RetentionSpec` is unchanged. |

**The `reportsList` collection** (`reports/core`) is served by `serveCollection(reportsList, { from: _reports })`:
- `liveCollection("reports.list", …)`, `id: "id"`;
- the filterable columns are today's `REPORTS_FILTERABLE`;
- sortable: kind, source, count and lastSeenAt;
- default `lastSeenAt desc`, limit 100, `maxLimit: 500`;
- `scroll: true`, `columnScope: "debug.reports"`.

One collection serves the window, `:rows` and `:groups`.

**Facets primitive (data-view).**
- `liveDataSource(c, { searchable, facets })` reads `useLive(c, { groupBy, limit: maxLimit })` for each facet column.
- `FieldDef` gains `optionsResult: { loading } | { error, retry } | { ready, options }`, exclusive with `options` (T8).
- Options are sorted by value, so they never move under the cursor.
- A grouping that still `canGrow` at `maxLimit` is the error arm, never truncated.
- P6 and P7 reuse it.

**Web.**
- `ReportsView` uses `liveDataSource(reportsList, { searchable, facets: ["kind", "source"] })`.
- `useReport` becomes `useLiveRow`, and the pane resolves with `resolveRow`.
- Investigate keeps an optimistic `linkedTaskId` until the live row agrees; this replaces `onLinked` / `refetch`.

**Deleted.**
- `reports.revision` (both sides).
- `handle-query.ts` and `handle-read.ts`.
- `queryReports`, `reportFacets`, `getReport` and their schemas.
- `ExcludeFromChangeFeed(reports)`.
- `export { _reports }`.
- `web/internal/revision.ts` and `use-report.ts`.
- The lint allowlist lines (`network/live/lint/index.ts:127-131`).

**Volatility contract** (goes in the doc's Known limits):
- A pending coalesced change is lost on a restart or hot swap. Clients resubscribe and reload in full.
- Within one subscription, a lost emit heals membership (`windowIdsOf`) but not the values of rows already in the
  base.
- A6 keeps "lost" from ever becoming "persisted wrong".

### P6: runs as a routed union window

**Layering.**

| Layer | Knows |
|---|---|
| `query-resource` | The union window compiler (`compileUnionWindowQuery`, the N-arm assembler) and its route minting. It knows tables, joins, SQL and routes. It does not know the filter language or runs. |
| `network/live` | `liveCollection({ arms })`, `liveArmColumns`, `serveUnionCollection`, and arm pruning (`testClause`, now in the filter plugin). |
| `runs` | The collection, `defineRunKind`, `RunsDataView` and `useRun`. It names no arm. |

**Lifting the refusal (`routes.ts`).**
- `compiledRoutePlan` takes `RawRoute[]` with `encode?: never` (T10, replacing P4's runtime throw).
- `compiledUnionRoutePlan(arms)` wraps each arm's raw routes with `armKeyCodec(kind)`:
  - `encode = kind:raw`;
  - `decode` strips the `kind:` prefix (raw ids may contain `:`).
- What the wrapper does per route kind:
  - identity and alias gain `encode`;
  - reverse wraps `resolve`: decode `within` to that arm's raw ids (skip the probe when it is empty), probe, then
    encode the answer; `over-cap` passes through.
- `KIND_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/`, so route ids `<kind>` and `<kind>.<alias>` are unique.

**The collection** (`runs/core`):
- `liveCollection("runs", { row: RunRowSchema, id: "runKey", arms: { discriminator: "kind" }, scroll: true, … })`;
- `runKey = kind:id`, projected by the compiler;
- default `startedAt desc`, limit 50, `maxLimit` 200.
- The `arms` overload forbids `contributed` / `columnScope` and requires `scroll` (T12).
- Base field ids bind by name.

**Arm columns.**
- `liveArmColumns(runs, kind, { row, filterable, sortable })` returns a handle with `owner: { kind: "arm" }`.
- `LiveColumnsDeclaration` becomes owner-discriminated (contributed / scoped / arm). The codec and data-view's
  `columnFor` switch on it exhaustively (T11).
- Wire and field ids stay `<kind>.<field>`, so saved views need no migration.
- Outer SQL names are positional (`__c<i>`), so `build.exitCode` and `deploy.exitCode`, or `release.kind` and the
  discriminator, never meet in SQL.
- `handle.read(row)` returns null for another arm's row, and throws when the row is its own arm's and the slice is
  missing (A16).
- `arm-value.ts` and `UnionRunSchema.catchall` are deleted.

**Server arm spec (`defineRunKind`).**
- Fields: `{ columns: handle, from, id: PgColumn, joins?, base(j), extra(j), where?(j) }` (T9).
- `id` and `duration` are derived, so neither appears in `base`.
- `duration = finishedAt − startedAt` (NULL while running), replacing `durationMsExpr`'s `now()`.
- Register-phase checks: kinds are unique and match `KIND_RE`.
- **Deploy label.** `lookup("server", _deployServers, { on: base.serverId, required: false })`, with the label as an
  `ExprField`. The correlated subquery can no longer be written: `columnsIn` throws on an undeclared table.

**Compiler semantics.**
- **Nullability** is derived per outer column: an arm renders NULL, a nullable column, a LEFT join, or raw SQL without
  `notNull`.
- **`moves`** are computed per arm by compile-window's own rules, so `arm.where` columns such as `namespace` are
  included.
- **Total order** is (tuple keys…, `runKey`).
- **Shapes:**
  - **Full:** a per-arm `where ∧ cut`, `ORDER BY`, `LIMIT`, then `UNION ALL` and the outer cut, order and limit.
  - **Scoped refill:** ids decoded and grouped by arm; arm where, tuple where and cut, plus `id = ANY`.
  - **`windowIdsOf`:** the full shape, projecting the key only.
  - **Point:** grouped by kind, keeping `arm.where`. An unknown kind or an undecodable id is **absent, not a contract
    error** (a contract error is page-terminal).
  - **`:groups`:** `compileArmGroups`.
- **Gate columns** are every select expression plus `arm.where`, `id`, and the signature and where columns. pid-only
  and `leg_run_id` writes route nowhere.
- **`armsOf(params)`** prunes over AND-reachable clauses. `usesOf` drops the routes of pruned arms.
- **`signatureColumns`** = base sortables ∪ every handle's sortables (A15 guard).

**Web.**
- `RunsDataView` uses `liveDataSource(runs, { searchable: [label, message, namespace, trigger] })`.
- `emptyState` becomes required, and every caller passes its own copy (`hasRuns` is deleted).
- `useRun` becomes `useLiveRow(runs, runRowKey(ref))` and returns a `LiveRowResult`. `RunRead` is deleted.
- Backup panes use `resolveRow`, so a stale row stays `FOUND` on a transient error.
- `<RunDuration>` formats `useNow(1000) − startedAt` while running and `duration` when finished, with one formatter.

**Deleted.**
- `runs.revision`.
- `queryRuns` / `getRun`, `handle-query.ts`, `handle-get.ts`, `query-defaults.ts` and `arms.ts`.
- `arm-value.ts` and `RUN_COLUMN_DOMAINS`.
- **The whole `primitives/data-view/plugins/union-query` plugin.** Its only importers are runs files.
- The lint group (`:132-137`).

**First routed layout on `backup_runs`.** This means one trigger rebuild at the next boot.

### P7: conversation lists (All-conversations and sidebar History)

**List row.** `ConversationListRowSchema = ConversationSchema.pick(…)` with these fields:
- `id`, `title`, `status`, `model`, `kind`, `runtime`, `spawnedBy`;
- `createdAt`, `updatedAt`, `endedAt`;
- `worktreePath`, `taskId`, `taskTitle`.

It leaves out `active`, `waitingFor`, `lastViewedAt`, `claudeSessionId`, `closeRequested` and `hibernatedAt`, none of
which the list surfaces read. So poll writes (the tmux poller's `waitingFor`, `lastViewedAt`) are gated out of both
list routes. `ConversationSchema` is unchanged.

**Shared joins and columns (`tasks-core/server`).** Both are reused by P8.
- `conversationOwnerJoins` = `lookup(attempt, _attempts, on base.attemptId, required)` →
  `lookup(task, _tasks, on attempt.taskId, required)`.
- `conversationOwnerColumns` = `{ worktreePath, taskId, taskTitle }`.
- The joins are INNER: the NOT NULL cascade FKs make INNER lossless.

**Two collections**, one per `columnScope`. `liveColumnScopeOf` requires `columnScope === storageKey`.

| Collection | `columnScope` | Default |
|---|---|---|
| `conversations.all` | `"all-conversations"` | `{ unless: "kind", where: kind <> 'system' }` |
| `conversations.history` | `"conversations-sidebar"` | none |

- Both are declared literally (the scanners need the literal call) and share the `CONVERSATION_LIST_*` consts.
- Both are compiled from `_conversations`, never from the view (A1).
- Sortable: title, createdAt, updatedAt. `updatedAt` is derived and moves only on title, model and status
  transitions.
- Searchable: title, model, worktreePath, taskTitle.

**Routes.**

| Table | Route | Gate |
|---|---|---|
| `conversations` | identity | the projected columns + `attempt_id` |
| `attempts` | reverse on PK | `{id, task_id, worktree_path}` |
| `tasks` | reverse through `INNER JOIN attempts` | `{id, title}` |
| custom values | scoped family | as in P3 |

- The `tasks` hop is through `attempts`, which is not the changed table, so A10 passes.
- **A rename is value role.** `moves` = `{id}`, plus `title` only for a tuple that filters or searches `taskTitle`.
  The rename therefore refills exactly that task's member conversations, with no `windowIdsOf`.

**Web.**
- The All pane uses `source={liveDataSource(allConversations, …)}`.
- History uses `source` in the **merged** sidebar DataView. This is the first merged surface with a live origin, so it
  gets a jsdom test and an e2e.
- `conversationFieldDefs` gain no `column` refs. The in-memory Queue reuses them, and a `column` there throws at mount.

**Deleted.**
- `conversations-revision`.
- `handle-query.ts`, including its `ViewBaseConfig` hack.
- `column-map.ts`, and `queryConversations` with its endpoint and schemas.
- The lint group (`:110-114`).

**Left for P8.** `conversations_v`, `ConversationSchema`, `conversationCascadeSignatures`, and the
`conversations-*` resources. A5 is untouched, because nothing depends on the new collections.

### Item 7 remainder

**I7a: `events.runs-revision` → `events.source-runs` collection.**
- It follows the `deployRunHistory` precedent: a window over `event_source_runs`, scoped per source with
  `.scoped({ where: { sourceId } })`.
- `columnScope: "events.source-runs"`, scroll, `startedAt desc`.
- `useEventSourceRun` becomes `useLiveRow`.
- Deleted: the tick, `listEventSourceRuns`, `getEventSourceRun` and their handlers, `listRuns`, and the lint lines.

**I7b: `latency-ledger.revision` → `latency-ledger.summary`.**
- An external `liveValue` with typed `window` param (I7p).
- Its tables stay feed-excluded; the flush is the change source. `noteFlushedMinute` notifies each window.
- `responsiveness-section` reads `useLive`.
- Deleted: the tick and the summary endpoint.

**I7c: `release.history-revision` → two reads.**
1. The latest run comes from `useLive(releaseHistory, { where: { composition }, orderBy: startedAt desc, limit: 1 })`.
2. `release.candidate` is an external value:
   - its loader is `createSignedMemo` over (HEAD, `realpath(latest-<platform>)`, `RELEASE.json` mtime);
   - `revalidate` is the memo's signature;
   - `recomputeOn: [refHeadServed]`;
   - `closeReleaseRow` notifies it after its guarded UPDATE returns a row.

The rest of I7c:
- **Ordering.** Nothing orders the two streams on the server. So `use-release-info` holds `loading` while the latest
  succeeded run is not yet the candidate's `runId` (a client-side data gate).
- `ReleaseInfo` becomes a `loading | error | ready` union, and the chip and section render the error arm.
- Deleted: the tick, the candidate and latest endpoints, `ReleaseCandidateResponseSchema.run`, and
  `useRevisionRefetch`.

**I7d: delete the fetchPage DataView path** (after P5, P6 and P7).

Deleted:
- the types `ServerDataSourceSpec`, `ServerPage`, `DataViewFetchPageOrigin` and `changeTick`;
- `useServerDataSource`, and the `dataSource` / `serverFields` / `globalExtensionIds` blocks in `data-view-body.tsx`;
- `ServerFilterWireSchema`;
- **the whole `data-view/plugins/server-query` plugin**;
- the custom-columns `query-augmentor` contribution;
- `ServedScopedColumns.unwatchedFamily`;
- the keyset cursor codec (`encodeCursor`, `decodeCursor`, `sortSignature`).

Kept:
- `KeysetSortRule` and `keyset/server`;
- `lowerSearch`, `lowerServerFilter`, `useServerFilter` and the `Unavailable*RuleError`s, which move to
  `live-filter.ts`.

Item 9 note: once P8 lands, `ResourceDescriptor.initialData` is seeded only by `pages`, `page-links` and config.
File that against item 9; it is not deleted here.

### P8: the tree rewrite

**An `all` collection arm (`network/live`).**

```ts
liveCollection(key, { row, id, all: { orderBy, unbounded: { reason } }, preload?: "boot" })
// mints `${key}` (param-less, the whole ordered set) and `${key}:rows`
```

- `default`, `maxLimit`, `filterable` and `scroll` are `never` (T13).
- `useLive(all)` returns `ResourceResult<Row[]>`.
- `useLive(all, { select })` is gated. This keeps the per-id re-render isolation of `useConversation`
  (`use-conversations.ts:76-94`).
- `useLiveRow(all, id)` stays available.

**The persisted-alias compiler (`query-resource/compile-alias.ts`).** It is the assembler's `all` mode. It emits
`{ routes, scopedMembership: { orderOf } }`, the routed arm `runtime.ts:540-549` already types. Being unbounded and
preloaded, it is L2-persisted, so it:
- refills **scoped** via `drainMembershipScoped`;
- keeps a `"kept"` snapshot with no subscriber;
- receives `{}` from `routedTargets`.

It emits two more things:
- **An order signature derived from `orderBy`.** The runtime's unbounded branch now honours `orderMoved` (today only
  the bounded branch does, `runtime.ts:4300-4316`). So a `rank` drag reorders `tasks` with one `orderOf`, and "a
  mutable ORDER BY that never reorders" cannot be written.
- **A definition fingerprint**: sha256 over the rendered SQL, the row schema, and the signatures of the rollups it
  reads.

**Join kinds** (`query-resource/core/internal/joins.ts`; routes in `server/internal/joins.ts`).

| Kind | Renders | Routes |
|---|---|---|
| `rollup` (`on` = base pk) | A join on a derived-tables rollup | `alias(carry)` on each rollup **source** table (A1 forbids routes on rollups) |
| `rollup` via a hop | — | `reverse` through the hop |
| `children` (`on` = base pk, `fk`) | Aggregates, or `jsonAgg(cols, orderBy)` = `COALESCE(json_agg(json_build_object(…) ORDER BY …) FILTER (WHERE pk IS NOT NULL), '[]')`, each child column through its wire codec | `alias(fk)` on the child table |
| `closure` (`edges`, `child`, `parent`, `ancestorJoins`) | A recursive-CTE dependents expansion with `LIMIT cap+1` | Per provenance route, an extra `<id>:closure` reverse route gated on the predicate columns. The edge table gets `alias(child)` plus the expansion. |

- **The closure is exempt from A10 (A23)**, with the proof in the compiler: expanding from the deleted edge's carried
  child reaches every former descendant.
- **Rollups become data.** `DerivedRollupSpec` gains `sources: { table, carry, via?, reads }[]`.
  - The maintain function's column list is generated from `sources[].reads` (A21).
  - At boot, the `pg_trigger` callers of each maintain function must equal `sources`.
  - `task_latest_conversation` gains `attempts` as a source, through an AFTER DELETE / UPDATE OF `task_id` trigger.
    This fixes a staleness bug when an attempt is deleted.
- **A8′ / A22.** A captured read-set must be ⊆ route tables ∪ `derivedReads` whose sources are all routed.

**L2 correctness** (`live-state-snapshot`, runtime).
- **Fingerprint (A18).** `live_state_snapshot` gains `definition`. On a mismatch the key is not seeded and not served
  by the boot snapshot, and it runs one full load. The boot snapshot serves L2 to **every page load**, so a stale
  definition is not acceptable.
- **Reconcile heals.** The derived-tables reconcile counts the rows it healed per rollup, and `onRollupHealed(table)`
  full-reloads every reader of that rollup. A20: the reconcile completes before `live-state-snapshot` `onReady`, or
  boot throws.
- **Watermark floor (A19).**
  - A scoped persist upserts `position = LEAST(stored, W)`; a full persist writes `W`.
  - The hourly `live-state-snapshot.compact` job full-recomputes every persisted alias whose position is more than an
    hour old, which keeps the changelog prune moving.
  - Catch-up's "pruned ⇒ FULL" stays the backstop.
- **Coalesced persist.** A scoped drain marks the key dirty, and one trailing persist runs per key per 2 s, at the
  minimum watermark seen since the last persist. A crash loses nothing, because the floor never moved.

**The resources.**

| Resource | Compiled from | Joins | Routes |
|---|---|---|---|
| `task-categories` | `tasks_ext_category` | — | identity |
| `tasks` | `_tasks`, ordered `[rank, createdAt]` | <ul><li>`children(att, _attempts)` with the conv and push rollups: `hasAttempt`, `hasCompleted`, `hasActive`, `hasWaiting`, `minCompletedPushAt`</li><li>`children(deps, _taskDependencies)`: `dependsOn[]`</li><li>`closure(blocking)` with `depIsBlocking` re-parameterised over `{droppedAt, heldAt, hasCompleted}`</li></ul> | <ul><li>`tasks`: identity + closure</li><li>`attempts`: `alias(task_id)` + closure</li><li>`conversations` and `pushes`: reverse via attempts + closure</li><li>`task_dependencies`: `alias(task_id)` + `:closure`</li><li>none `full`</li></ul> |
| `attempts` | `_attempts` | <ul><li>`rollup(conv)`, `rollup(push)`</li><li>`children(convs, _conversations, kind <> 'system')` → `conversations: jsonAgg(summary cols, createdAt asc)`</li></ul> | <ul><li>identity</li><li>`alias(attempt_id)` on `conversations` and on `pushes`: **fixes C1**</li></ul> |
| `agent-launches` | `_agent_launches` | `rollup(latest, task_latest_conversation, on taskId)`, flattened to `latestConversation*` | <ul><li>identity</li><li>reverse on `conversations` via `attempts`</li><li>`alias(task_id)` on `attempts`</li></ul> |
| `conversations-active` / `-system` | `_conversations` | `conversationOwnerJoins` + `conversationOwnerColumns` + the full `ConversationSchema`, with `active` as an `ExprField` | identity + the two reverses. A `waitingFor` write is a one-row identity refill and reaches no tree route. |
| `conversations-gone` | `_conversations` | A window: `status = 'done' AND ended_at IS NOT NULL AND kind <> 'system'`, `endedAt desc`, limit `RECENT_GONE_LIMIT`, preloaded | as above |

Supporting changes:
- **Shared builders.** `taskDerived`, `attemptDerived` and `depIsBlocking` are extracted from `views.ts`, and
  `tasks_v`, `attempts_v` and `task_blocking_v` are rebuilt on the same builders. A parity oracle checks that
  compiled `tasks` / `attempts` equal the views.
- **`attempt_conv_agg` gains `has_waiting_conv`** (ALTER; covered by the fingerprint and the reconcile heal).
- **`taskDetail` becomes `taskDescriptions`**, a lookup-only `{id, description}` collection. The prompt merges the
  list row with the description.
- **`conversationsGoneStats` stays** a legacy-full COUNT `serveValue`.
- **Consumers move from `useResource` to `useLive`.** The authoritative list is the "Item 3" burndown group in
  `network/live/lint/index.ts:36-108`.

**Conversion order (A5 holds at every step).**
1. `task-categories`.
2. `tasks`.
3. `attempts`, then delete the carrier.
4. `agent-launches`: the last downstream of `conversations-active` goes.
5. `conversations-active` / `-system`, then `-gone`.
6. Deletions.
7. The A7 pane.

**S0′ benchmark gate (stop).** On a main fork, compare a full alias `tasks` load with `SELECT … FROM tasks_v` (about
67 ms for 4,967 rows). If the alias is more than 2× slower, render the **full** shape set-based (the `task_blocking_v`
CTE) and keep the laterals for scoped shapes only. Decide before converting `tasks`.

**The declared legacy-full path.**
- **`ScopePolicy`:** a keyed DB entry has only the routed arms (T14). The legacy arms (`runtime.ts:519-574`, including
  `recompute`) are deleted. With them goes the edge-covered point drop, which is then impossible to express.
- **`applyDbChange` becomes `applyLegacyFullChange({ table, source, xid, changedAt })`.** It schedules `affected = null`
  for the readers found through read-set inversion: `serveValue(db)`, `pages`, `page-links`, `agentRows` and
  `conversationsGoneStats`.
- **No view forwarding.** `tableToResources()` expands each captured relation through an injected
  `setRelationBases(fn)`: the transitive `view_table_usage` closure, with rollups mapped to their `sources`. It runs at
  inversion time, so read-sets seeded from L2 resolve too. It replaces `setRelationResolver`.
- **`DependsOnEntry.resource` is an `ExternalResource`** (T15, plus a `createResource` throw). Upstreams to verify as
  external at S6: `customColumnDefsServed` and the `configValues` upstream.
- **A25:** a membership entry has no downstream. This lands only at S6.

**The A7 Read-set pane, made honest.**
- `_debug` emits per entry:
  - `policy: routed | legacy-full | external`;
  - `persisted` and `definition`;
  - `readSetBases`, with views expanded and rollups mapped to their sources, no longer filtered out;
  - `derivedReads`.
- `computeCeiling` lists every legacy-full entry with its bases, tuple count and persisted flag. It no longer skips
  entries without an `identityTable`.
- Section C (over-broad `dependsOn`) is deleted.
- A26: a test checks that every registry entry appears with a policy.

**Deleted at S6.**
- `rel.ts`.
- `compileEdges`, `compileQuery`, `queryResource`, `Edge`, `Hop` and `QueryResourceSpec.edges`.
- `pushesAttemptsCascade`, `listConversationSummariesByAttempt`, `conversationCascadeSignatures` and
  `TRANSIENT_CONVERSATION_FIELDS`.
- In the runtime:
  - `coveredOriginsFor`;
  - the secondary-view dedup;
  - the edge-covered `continue`;
  - the identity-origin scoping and the legacy point intersection;
  - `affectedMap` / `signature` / `lastSignatures`;
  - the membership-drain cascades (`:4187`, `:4439-4447`);
  - the legacy `ScopePolicy` arms;
  - `DefineResourceInput.identityTable`.
- `keyedResourceDescriptor`.
- In change-feed and derived-views: `route-change.ts:61-72` (view forwarding), `dependentViews`,
  `relationIdentityBase` and `View.identityTable`.
- The "Item 3" lint group.
- The `keyed-resource-scope` check is retargeted: a routed opts object declares exactly one of `membership` /
  `scopedMembership`.

## Build sequence

Each step ends with `./equin build` green, `check` included. Checkpoints (★) stop for your review.

| # | Step | Phase |
|---|---|---|
| 1 | <ul><li>`ChangeSource`; required `TableChange.source`</li><li>`RoutedChange` router input; `producer` notify counter; Read-set pane column</li></ul> | P5 |
| 2 | <ul><li>`defineChangeProducer` / `mutate`, the coalescer, the root context</li><li>A12, A13, testing barrel</li><li>denylist `produced`, A1′, A2′, A3p</li><li>retention's produced-table path</li><li>the A11 check</li></ul> No producer is declared yet; a boot test runs against a fixture table. | P5 |
| 3 | `persistedKeys()` + A6 (boot + runtime) | P5 |
| 4 | Facets primitive (`liveDataSource({ facets })`, `FieldOptionsResult`) | P5 |
| 5 | <ul><li>The reports producer replaces `ExcludeFromChangeFeed`</li><li>the four writers move to `mutate`; reap-job moves to the outbox</li><li>the `reportsList` collection and the web conversion</li><li>delete the tick, the endpoints and the lint lines</li></ul> **Atomic:** the producer and the routed collection must land together, or A1′ throws. | P5 |
| 6 ★ | P5 review checkpoint | — |
| 7 | `reverse.column?` (PK reverse reads `ids`) | shared |
| 8 | I7p typed `liveValue` params; then I7a (events runs), I7b (latency summary), I7c (release candidate + latest window), in any order | item 7 |
| 9 | Compile-window split into `planArm` / `assembleWindow`; groups into `compileArmGroups`. **Byte-identical 1-arm SQL** is the gate; nothing else lands in this step. | shared |
| 10 | The `ExprField` primitive, accepted in `serveCollection` `columns` | shared |
| 11 | <ul><li>`RawRoute`, `KIND_RE`, `armKeyCodec`, `compiledUnionRoutePlan`</li><li>delete the P4 refusal</li><li>owner-discriminated handles; `liveArmColumns`; the `arms` overload</li><li>scanner `arms:`</li></ul> | P6 |
| 12 | <ul><li>`serveUnionCollection`; the runs collection; `defineRunKind` + the four arms (deploy label as a lookup)</li><li>web: `RunDuration`, required `emptyState`, `useRun` → `useLiveRow`</li><li>delete `runs.revision`, the endpoints, `arm-value.ts` and **the `union-query` plugin**</li></ul> | P6 |
| 13 | <ul><li>tasks-core `conversationOwnerJoins` / `Columns`</li><li>the two conversation collections; web</li><li>delete `conversations-revision` and the HTTP query</li></ul> | P7 |
| 14 | I7d: delete the fetchPage path and `server-query`; move the filter lowering to `live-filter.ts`; the "Item 7" lint group is empty (A27) | item 7 |
| 15 ★ | Review checkpoint: P6, P7 and item 7 | — |
| 16 | P8 S0: <ul><li>scanner `all:`</li><li>the `all` arm and `useLive(all, { select })`</li><li>`compile-alias` as an assembler mode; unbounded `orderMoved`; the fingerprint</li><li>`rollup` / `children` / `closure` + `jsonAgg`; rollup `sources` + generated maintain columns; `derivedReads`</li><li>L2 `definition`, floor persist, coalesced trailing persist, `onRollupHealed`, the compact job; the A6 refusal moves into the trailing persist</li></ul> Splittable into 16a (L2) and 16b (compiler) if large. | P8 |
| 17 ★ | S0′ benchmark gate: alias `tasks` vs `tasks_v` | P8 |
| 18 | `task-categories` | P8 |
| 19 | `tasks` (`has_waiting_conv`, `taskDescriptions`, the shared builders; views rebuilt) | P8 |
| 20 | `attempts` (nested `conversations[]`); delete the carrier and `listConversationSummariesByAttempt` | P8 |
| 21 | `agent-launches` (+ `attempts` as a rollup source) | P8 |
| 22 | `conversations-active` / `-system` (on step 13's joins), then the `-gone` window; delete the cascade signatures | P8 |
| 23 | S6 deletions: <ul><li>`applyLegacyFullChange` with `source`; `setRelationBases`</li><li>T14, T15, A25</li><li>the "Item 3" lint group</li><li>check retarget</li></ul> | P8 |
| 24 ★ | A7 pane honesty + A26; final review | P8 |

**Hard orderings.**
- Step 5 is atomic. A1′ needs both halves in place.
- Step 9 lands alone, before any union code.
- Step 14 needs steps 5, 12 and 13.
- Step 22 needs steps 19–21 (A5).
- Step 23 needs steps 5, 8, 12, 13 and 22: every hand-written `identityTable` must be gone. The last one is
  `event-runs.revision`.

At each checkpoint the parent doc gets an "as landed" section for the phases done.

## New assertions

The ids continue from the parent doc's A1–A10 and T1–T3.

| ID | Rule | Rung |
|---|---|---|
| T4 | The producer executor is `NodePgDatabase` (no transaction) | type |
| T5 | `TableChange.source` / `applyLegacyFullChange.source` are required | type |
| T6 | `mutate`'s `latency` is required | type |
| T7 | `mutate` takes a builder on its own table only; there is no `emit` | inexpressible |
| T8 | `FieldDef` sets `options` xor `optionsResult` | type |
| T9 | `RunKindSpec.id: PgColumn`; `id` and `duration` derived; `extra` keys = the handle's fields | type |
| T10 | `compiledRoutePlan` takes `RawRoute` (`encode?: never`) | type |
| T11 | `LiveColumnsDeclaration` is owner-discriminated, with exhaustive switches | type |
| T12 | `arms` overload: `scroll: true`, no `contributed` / `columnScope`; `RunsDataView.emptyState` required | type |
| T13 | An `all` collection requires `unbounded.reason`; window and lookup keys are `never` | type |
| T14 | A keyed DB entry has routed `ScopePolicy` arms only | type + retargeted check |
| T15 | `DependsOnEntry.resource` is an `ExternalResource` | type + runtime |
| T16 | Typed `liveValue` params | type |
| T17 | No `dataSource` / `ServerDataSourceSpec` spelling; `ReleaseCandidate` has no `run` | inexpressible |
| A1′ | covered = triggered ∪ produced | boot |
| A2′ | One producer per table; produced ∩ (excluded ∪ feed-exempt) = ∅; no notify trigger on a produced table | eval + boot |
| A3p | A route on a produced table carries no columns | boot |
| A6 | No persisted reader of a produced table: boot throws on static evidence; stale L2 rows are deleted and reported; the trailing persist refuses → never-persist | boot + runtime |
| A11 | A write to a produced table outside `mutate` | check |
| A12 | `mutate` on an unmounted producer throws | runtime |
| A13 | `mutate` outside `serve` boot mode throws | runtime |
| A14 | Union compile: kinds unique and match `KIND_RE`; arm id = single-column PK; every outer column has a `sqlType`; route ids unique | bind |
| A15 | A function `orderBy` needs `signatureColumns` covering it (a shared guard) | bind / tuple |
| A16 | `handle.read` throws on its own arm's row with a missing slice | runtime |
| A17 | A PK reverse carries no PK column in the layout | unit + A3 |
| A18 | A persisted alias whose `definition` ≠ fingerprint is not seeded or served; one full load | runtime |
| A19 | A scoped persist never raises `position` (`LEAST`) | runtime + test |
| A20 | The derived-tables reconcile completes before `live-state-snapshot` `onReady` | boot |
| A21 | Maintain-function columns are generated from `sources[].reads`; `pg_trigger` callers = `sources` | rung 1 + boot |
| A22 | Captured read-set ⊆ route tables ∪ `derivedReads` with routed sources (A8′) | runtime, strict in tests |
| A23 | The closure edge-table route is exempt from A10, with the proof in the compiler; ids are `<id>:closure` | compiler |
| A24 | Children / closure `on` = base pk; a child's rollup hangs off the child; `ancestorJoins` names declared joins | module eval |
| A25 | A membership entry has no downstream | runtime (from step 23) |
| A26 | Every registry entry appears in the A7 payload with a policy | test |
| A27 | The "Item 7" lint group is empty; `resourceDescriptor(` is pinned to the two page keys; no fetchPage symbol resolves | check |
| A28 | Every `liveCollection` arm (window, lookup, `arms`, `all`) is classified correctly by `resource-vocabulary` | test |

## Critical files

**Framework**
- `plugins/framework/plugins/resource-runtime/core/{routing,runtime}.ts`: source, legacy-full, `orderMoved`,
  persist, `ScopePolicy`, `_debug`.
- `server-core/core/resources.ts`.

**Query compilers**
- `plugins/infra/plugins/query-resource/{core/internal/{joins,expr}.ts, server/internal/{compile-window,compile-groups,compile-union-window,compile-alias,joins,routes}.ts}`.

**`network/live`**
- `plugins/network/plugins/live/{core/internal/{live-collection,live-columns,live-value,query-codec}.ts, server/internal/{serve-collection,serve-union,serve-value}.ts, web/internal/use-live.ts, lint/index.ts}`.

**Database**
- `plugins/database/plugins/change-feed/server/internal/{producer,route-change,triggers,route-coverage,exclusion,view-deps}.ts`.
- `live-state-snapshot/server/internal/{persist,tables-ddl,catch-up,compact-job}.ts`.
- `derived-tables/server/internal/rebuild.ts`.
- `derived-views`.
- `plugins/infra/plugins/retention/server/internal/define-retention.ts`.

**Data-view**
- `plugins/primitives/plugins/data-view/{core/internal/types.ts, web/internal/{live-data-source,live-fields,live-source,data-view-body}.tsx?}`.
- Deleted: `plugins/server-query`, `plugins/union-query`.

**Domains**
- `plugins/reports`, `plugins/debug/plugins/reports`.
- `plugins/runs`, the four `runs-arm` plugins, `plugins/backup/web`.
- `plugins/conversations/plugins/all-conversations`, `conversations-view/plugins/data-view/plugins/history`.
- `plugins/tasks/plugins/tasks-core/server/internal/{resources,views,tables,joins}.ts`, `task-category`,
  `conversations/plugins/agents`.
- `apps/events/events-core`, `debug/plugins/latency-ledger`, `release`, `remote-deploy`.

**Debug pane:** `plugins/debug/plugins/read-set`.

## Verification

**Per step**
- `./equin build`, backgrounded with `await`, and `check` green. That covers type-check, plugin-boundaries,
  `plugins-doc-in-sync`, `resource-runtime:compiled-routes`, the new A11 / A27 checks, and A28.
- `./equin test` over the touched plugins.

**Unit and type**
- Every `@ts-expect-error` for T4–T17.
- The rule fixtures in `route-coverage`, `route-layout`, `routes`, `compile-union-window`, `compile-alias`,
  `producer`, `live-value` and `runtime-table-routing`. They cover source counters, acks, `orderMoved`, persist
  coalescing and the floor.
- Step 9's byte-identical SQL snapshot.

**DB oracles** use real triggers. At quiescence every client view must equal a fresh FULL load. Strict scoped-refill
bounds are asserted only after the previous frame has landed.

| Oracle | What it drives |
|---|---|
| reports list | the producer under `mountProducersForTest`: upserts, investigates, noise flips, sweeps; facets exact |
| serve-union | arm-`where` flips, pid-only writes, lookup renames under and over 500, retention and cascade deletes, raw ids with `:` |
| conversations collection | renames, moves, cascades, system status flips; C1 (identity over cap), C2 (reverse over cap), C3 (a 150-row `tasks` update keeps `ids` after step 7) |
| events source-runs, release history (limit 1) | — |
| tree oracle | 80 steps over tasks, edges, attempts, conversations and pushes, depth 4 and over cap; parity of `tasks` vs `tasks_v` and `attempts` vs `attempts_v` + summaries; L2 crash / fingerprint / heal cases |
| boot integration | producer A1′ / A2′ / A3p; A20 |

**Benchmark:** step 17 on a main fork.

**E2E** (after build; each script refuses main; seeds and cleans its own rows):
- `debug/plugins/reports/e2e/reports-live-verify.ts`
- `runs/e2e/runs-live.ts`: ticking duration, server rename relabels, backup deep links
- `all-conversations/e2e/list-live-verify.ts`
- `history/e2e/history-live-verify.ts`: rename relabels; system status flips
- events `runs-live-verify` (+ a custom-column sort)
- `release-info-live-verify`
- `summary-live-verify`
- `tasks-core/e2e/tree-live-verify.ts`: status flip → attempt + task; push completes A and unblocks B; rename →
  `conversations-active.taskTitle`; drag reorders; reload's first paint = live
- data-view `search-query-scope` / `control-panels` after step 14

**`get_runtime_profile` over each e2e run**
- **Gone:** the keys `reports.revision`, `runs.revision`, `conversations-revision`, `events.runs-revision`,
  `release.history-revision`, `latency-ledger.revision` and `pushes.attempts-cascade`; and the
  `/api/{runs,reports,conversations}/query` requests.
- **Push loads are scoped,** with `ids` ≤ changed + dependents.
- **Zero loads** on the list and tree keys for writes to `pid`, `rank` (except one `orderOf`), `lastViewedAt` and
  `waitingFor`. The one exception: a `waitingFor` write still does a one-row `conversations-active` refill.
- **Reports:** a `route` span labelled `reports`; Read-set pane `producer > 0`, `feed = 0`.
- **Persist spans:** ≤ 1 per key per 2 s, each < 30 ms. Closure and reverse spans < 2 ms.
- **No FULL** outside boot, compaction, over-cap and the declared legacy-full entries.

**Final audit**
- The A7 pane lists every legacy-full entry with its bases.
- `rg` finds no `rel(`, `identityTable`, `compileEdges`, `ServerDataSourceSpec` or `changeTick` outside docs.
- The "Item 3" and "Item 7" lint groups are empty.
- The parent doc's follow-up table is closed.

## Risks (ranked)

1. **The P8 compiler + L2 rewrite (step 16) is new and broad.** A wrong L2 position means a stale first paint on
   every page load. Mitigations: the L2 crash-case oracle, A18 / A19, and catch-up's "pruned ⇒ FULL" backstop.
2. **Cold boot and full-load cost of the compiled `tasks`.** Step 17 gates it, with a set-based full shape as the
   fallback.
3. **The compile-window split (step 9)** is read by every `serveCollection`. Mitigation: a byte-identical snapshot and
   every existing oracle.
4. **Trigger rebuilds and row-pairing cost on hot tables** (`conversations`, `attempts`, `tasks`, the run tables,
   `pushes`, `task_dependencies`). Measure trigger time before and after step 13.
5. **The first merged DataView with a live origin** (History). Covered by a jsdom test and an e2e.
6. **The shared builders change the text of `tasks_v` / `attempts_v`,** which 25+ legacy readers read. Covered by the
   `views.test.ts` truth table and the parity oracle.
7. **Volatile reports loss** on restart or hot swap. It is documented, and A6 keeps it out of L2.
8. **Reverse-cap FULLs** (500) on a big server or task rename. These are correct and bounded; over-cap fixtures
   exercise them.
9. **Mechanical churn** from the required `source` / `latency` fields and the handle-owner union. tsc finds every
   site.

## Known limits after this task

- `serveValue(source: "db")`, `pages`, `page-links`, `agentRows` and `conversationsGoneStats` stay on the declared
  legacy-full path, each listed by A7. Value routes for param'd values (keyed by `page_id`, `song_id`, …) are a
  future item, not designed here.
- Reports values are volatile, as in the contract above. During a rate-limited burst the bell is quiet while the pane
  count moves every 2 s.
- A hand-run CLI release is seen on the next HEAD advance, release completion or remount.
- A facet over a joined text column would FULL its `:groups` on every rename, so none is declared.
- `ResourceDescriptor.initialData` deletion is filed against item 9; afterwards only `pages`, `page-links` and config
  seed it.

## Design provenance

1. **Code map.** Four area readers plus a completeness critic. The critic found the three extra item-7 ticks and the
   persisted-FULL fact.
2. **Design.** Per area (P5, P6, P7, P8 and the item-7 remainder): a design, two adversarial reviews (runtime
   correctness and architecture), and a revision. Every finding was checked against the code and accepted or
   rejected with a reason.
3. **Synthesis.** A cross-phase pass resolved the conflicts:
   - one `ExprField` primitive;
   - one assembler for window, union and alias;
   - `reverse.column?` lands before the union;
   - `source` is kept on the legacy-full path;
   - A6 lives in the trailing persist.
4. **Deviation from the design pass:** A11 is a static check rather than a connection-level SQL write observer
   (Default 8).

The full per-area designs, with every file:line citation, were the inputs to this doc.
