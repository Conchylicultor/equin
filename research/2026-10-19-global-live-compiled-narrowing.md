# Resources track [12]: compiled narrowing — row values become collections, computed values follow them

Track: Network Layer › Resources (`block-f64cfc08-6ec6-4ef3-9122-f143cc24798e`), item [12] (`task-1792315682-nghxjk`).

Background:
- Design context: `2026-10-15-global-live-declared-reads-for-db-values-v2.md`, target model points 3–4. Its "As landed — session 2" section lists the known limits.
- [11] is fully on main (`9424cf1133`, `735861c1f3`).

## Context

**What is wrong today.** Since [11], every DB-backed value declares whole-table reads.
- A whole-table read is correct but coarse: any write to any row of a declared table recomputes every subscribed tuple.
- **page-blocks has no `revalidate`.** So every `page_blocks` write anywhere sends every open page a whole-forest `update` frame, typing projections included.
  - On main, `deliver:page-blocks` has shipped frames of 40–102 KB.
  - Its comment "push drops a byte-identical result" is false: `sendUpdate` broadcasts unconditionally without `revalidate`.
- Row-order, custom-values, active-data bindings and trackViews behave the same way.
- **Computed values recompute on unrelated writes.** These are attempt-work, commits-graph, the 3 worktree externals and the 4 transcript values.
  - edited-files sends an invalidate frame plus a client revalidate on every `conversations` / `attempts` write: 14,975 `deliver:edited-files` rows on main.

**What the user chose: the clean end state** (2026-10-19), over a narrowed-value shortcut.
1. **A value whose payload is "the rows where col = param" is a collection.** One declaration yields the SQL, the router's row filter and per-row deltas. It has no loader, so a wrong filter has no spelling.
2. **A value computed from a few rows reads them only by following collection tuples.**
   - Its loader runs no SQL on those tables, so the existing table-level drift guard (A8) is the whole guard. No row-level guard is needed.
   - The conversation → attempt hop lives inside a compiled lookup join.
3. **The early-ack hole is closed at its source** by an end-of-transaction marker. It is checked in our own code and fails loudly.

**Framework changes S2–S3 were approved in principle** (S1, runtime ack holding, was dropped while implementing — see B). The `rowRead` / F1–F3 design was considered and dropped (exploration and panel notes are in the session scratchpad).

## Facts this rests on (verified in code)

**The router can already narrow per row.**
- `routeTuple` (`resource-runtime/core/routing.ts:583`) runs the gate, then the key filter (`route.rows` ∧ `use.match`), and only then the map.
- The change feed carries every route-declared `match` column in `keys`, DISTINCT over old ∪ new. A moved key therefore names both its hosts.
- Over the 7000-byte cap, keys become unknown, which means FULL (`change-feed/server/internal/triggers.ts:297-375`).

**No compiler narrows a collection by its own params yet.**
- `liveCollection`'s `all` form takes no params (`query-resource/core/internal/contracts.ts:53`), and `compileAllCollection` builds `routed.tuple({})` once.
- A window's scalar `where` never becomes a `use.match`. `arm-plan.ts:369` emits one only for join families.

**Identity is a single column.**
- `singlePrimary` (`query-resource/server/internal/identity.ts:41`) throws on a composite primary key.
- The trigger fills `ids`, and computes `unchanged`, only for a single-column primary key.
- These tables are composite: `data_view_row_order`, `data_view_custom_values`, `active_data_bindings`, `track_views`, `agent_note_authors`.

**A value can depend on nothing DB-backed.**
- `dependsOn` and `recomputeOn` take external upstreams only (T15, `runtime.ts:3660`, `:3894`).
- A membership drain cascades nothing (D32, `:3652`, `:3885`).
- `routedTargets` (`:7513`) reaches only tracked tuples.

**The ack hole.** `change-feed/server/internal/burst.ts`, in its header comment: "a burst split by a later socket read is still routed in two flushes". Narrowed tuples get skip acks, and so do collection tuples today.

**The push ledger is pull-fresh by design** (`tasks-core/server/internal/push-ledger/freshness.ts`). `ensurePushLedgerFresh()` runs on every pushes read, and a conversation insert bumps `attributionGeneration`.

**C39** (`network/live/CLAUDE.md`): converting a key to a collection under the same name must prove `parsed` under the old schema with `subscribeAsOldDescriptor`, or rename the key.

## Design

### A. Param-scoped `all` collection (`by`)

`network/live/core/internal/live-collection.ts`, compiled in `infra/query-resource` (not framework):

```ts
export const pageBlocks = liveCollection("page-blocks", {   // key decided by the C39 step (A.4)
  row: BlockSchema,
  id: "id",
  all: {
    by: ["pageId"],                                     // each tuple: every row where these fields = its params
    orderBy: [["rank", "asc"], ["createdAt", "asc"]],
    unbounded: { reason: "one page's content forest — reducer, overlay and document order need every block" },
  },
});
```

**The contract.**
- `pageBlocks.all` is `ResourceDescriptor<Row[], { [K in B]: string }>` (new `ScopedAllContract`).
- `validateParams` requires exactly the `by` keys, each a non-empty string.
- `preload` is `never` when `by` is set, so such a tuple is never L2-persisted. That lifts the A18 persisted-only wire-codec refusal for it.
- `:rows` stays global, keyed by `id`.

**The compile** (`compile-alias.ts` `compileAllCollection` and `arm-plan.ts`):
- Each `by` field must be a direct base column (no join, no computed field), typed text, uuid or int. Timestamps and floats are refused, because the trigger's `col::text` must equal the param string.
- One loop over `by` emits all three of:
  - the SQL `eq(col, $param)`;
  - `baseIdentityRoute(…, { match: byCols })`;
  - `usesOf(params).base.match = { col: {params[f]} }`.
- `by` columns also join `moves`. The tuple becomes truly param'd.
- Only `routes.ts` mints the plan (the `compiled-routes` check is unchanged).

**The read** (`network/live/web/internal/use-live.ts`):

```ts
useLive(pageBlocks, { where: { pageId } })              // type: exactly { [K in B]: string }, nothing else
useLive(pageBlocks, { where: { pageId }, select: headingsInOrder })
useLiveRow(pageBlocks, blockId)                          // unchanged
```

**The optimistic overlay** (`primitives/optimistic-mutation/web/internal/`):
- Extract `resolveOptimisticSource(source, query) → { resource, params }` into `source.ts`.
- `useOptimisticResource`, `enqueueResourceWrite` and `enqueueDetachedWrite` all call it, and gain the scoped-collection form. A lane derived two different ways then has no spelling.
- `serverData` stays a `Block[]` in rank order:
  - deltas merge by key;
  - an upsert without `order` keeps its position (the typing projection);
  - an entrant, exit or rank move ships `order`.
- **Confirmation.**
  - After the first load, an op is confirmed by its exact `ackTx` plus content (`isReflected`).
  - Denial by watermark happens only on full frames (Rule B′, unchanged).
  - This is sound only once the hole is closed (B), so B lands first.
- Add an `ackOverflow` per-tuple `_debug` counter: past 64 sourceTx the ack is suppressed.

**A.4 Old bundles.** Run `subscribeAsOldDescriptor(pageBlocks old, { params: { pageId } })`, and check what an old non-keyed client does with a `delta` frame.
- Keep the key only if the result is `parsed` and an old tab handles `delta` loudly (resub, never a silent mis-merge).
- Otherwise rename to `page-blocks.v2`. Send lanes are per tab, so a rename costs nothing across a deploy.

**page-blocks migration** (session 1):

| Site | Change |
|---|---|
| `page/plugins/editor/server/internal/resources.ts` | `serveValue` → `serveCollection(pageBlocks, { from: _blocks, where: c => isNull(c.base.deletedAt), columns: { rank } })`, with the same rank binding `page-rows.ts` uses. Delete the false comment. |
| `editor/server/internal/handle-list-blocks.ts` | read through the served collection, so it cannot drift from the read |
| `editor/web/block-store.ts:158` | `useOptimisticResource(pageBlocks, { where: { pageId } }, …)` |
| `editor/web/composite-block-store.tsx` (~323, 334, 382) | `enqueueDetachedWrite(pageBlocks, { where: { pageId: owner } }, …)` |
| `history/…/page-version-preview.tsx:45`, `page-outline.tsx:65` | `useLive(pageBlocks, { where: { pageId }[, select] })` |
| `page-tree/web/panes.tsx:502` (`useBlockCrumb`) | `useLiveRow(pageBlocks, blockId)` |
| `editor/lint/no-adhoc-structural-write.ts:64` | update the message to the new call |

Gate on typing: `page_blocks` has a single-column pk, so `unchanged` works. A `data`-only update leaves every `moves` column unchanged. It becomes a one-row value refill on its own page and a skip on every other page.

### B. End-of-transaction marker (session 1, before anything can skip)

**Revised 2026-10-19 while implementing: change-feed only, no framework change.** The first draft held acks inside the runtime (S1). The cleaner place is the burst router. It already exists to route one transaction's changes as one burst, and it is only wrong when a socket read splits that burst. If it waits for the transaction's `$end` before routing that transaction's changes, the guarantee is exact. The runtime's ack semantics stay unchanged: an ack is still true for every change routed before its drain. S1 is dropped.

**The trigger.**
- A `CONSTRAINT TRIGGER live_state_txn_end AFTER INSERT ON live_state_changelog DEFERRABLE INITIALLY DEFERRED FOR EACH ROW`. Both notify functions insert one changelog row per statement.
- It emits once per transaction, guarded by `set_config('live.txn_end', <xid>, true)`: `pg_notify('live_state_end', {x, n})`, where `n` is that xid's changelog row count (`live_state_changelog_xid_idx`).
- Deferred triggers fire at commit after every statement, so `$end` is the transaction's last notification.
- It uses its own channel. All channels share one notification queue, so the order holds across channels. A backend still running the old code during a hot swap does not LISTEN on it, so it never sees an unknown payload.
- It is installed in the prelude tx and fingerprinted with the shared layer.

**The listener and the burst router** (`listener.ts`, `burst.ts`):
- LISTEN on both channels.
- A change carrying `x` is buffered under its xid. The xid's changes route together, in arrival order, once its `$end` has arrived.
- A change with no xid routes in the next macrotask, as today. That covers producer changes (`source: "producer"`) and `fullSweep`.
- Loud failures are reported, then the changes are routed, so nothing is ever dropped:
  - a change for an xid after its `$end` (`change-after-end`);
  - `routed > n` (`pg_notify` drops an identical payload within one transaction, so `n` is an upper bound);
  - a new xid's change arriving while an older xid is still open (one transaction's notifications are contiguous);
  - an xid open past a one-shot deadline (`txn-end-missing`, 2 s). This is one timer armed per open xid, not a poll.
- The catch-up replay routes per xid already (one batch). It is unchanged.
- A boot assertion (in `installFeed`): no other deferred trigger exists on a routed table or on the changelog. Such a trigger could queue a notification after the marker.
- The `burst.ts` header's "a burst split by a later socket read is still routed in two flushes" paragraph becomes the statement of the fix.

### C. `follows`: a value follows collection tuples (session 2)

**Spelling** (`network/live/core/internal/compile-value.ts`, `server/internal/serve-value.ts`):

```ts
serveValue(attemptWork, {
  source: "db",
  follows: {
    attempt:  follow(attemptWorkspaces,      ({ attemptId }) => ({ ids: [attemptId] })),
    convIds:  follow(attemptConversationIds, ({ attemptId }) => ({ where: { attemptId } })),  // scoped all (A)
    pushIds:  follow(attemptPushIds,         ({ attemptId }) => ({ where: { attemptId } })),
    delivery: follow(attemptDeliveries,      ({ attemptId }) => ({ ids: [attemptId] })),
  },
  recomputeOn: [refHeadServed],
  loader: ({ attemptId }, { followed }) => attemptWorkFrom(followed),
  revalidate: …,
});
```

**The rules.**
- `tupleOf` names a tuple, never a row filter. The loader reads exactly that tuple's held value. The route and the read are one tuple by construction.
- A `reads.tables` entry that overlaps a followed plan's tables (after relation expansion) is refused at compile, so no row reaches a follower twice. That is what makes the T15 lift safe.
- An external follower keeps `changes: "notified"` for its non-DB truth (watchers, git).

**resource-runtime (S2, approved).** A third edge kind, beside `dependsOn` and `routedRecompute`:
- **Hold.** When a follower tuple is first tracked, the runtime holds the upstream tuple: a refcounted `entry.held` that opens a tracking span.
  - `routedTargets` becomes tracked ∪ held.
  - Held-only tuples send no frames.
  - The hold is released at the follower's last untrack.
- **Read.** `ctx.followed[name]` is the upstream's held value. On a cold hold the runtime awaits the upstream's own flight, under the upstream's loader entry, so A8 attributes those reads to the upstream.
- **Cascade.** D32 is lifted for follow edges only.
  - A membership drain whose diff is non-empty (or a FULL drain that changed the snapshot) calls `mergePending(down, …, null, sourceTx, changedAt)`. A follow cascade and a table change in one flush therefore make one load.
  - A reach upstream cascades only when its value moved (D8 identity).
  - `rebuildDag` orders the upstream before the follower.
- **Acks.** `tupleWantsAcks(upstream)` also counts followers that want acks. No migrated follower has an optimistic reader today, but the rule keeps acks exact.
- **Messages.** The other D32 / T15 / `recomputeOn` refusals stay, and their messages point to `follows`.

**Hop.** `conversationWorkspaces` is a lookup-only collection over `conversations`: `carry.pick: ["id","attemptId"]`, plus a lookup join to `attempts` for `worktreePath` and `workspace`, in tasks-core core.
- Its identity route is gated to `{id, attempt_id}`.
- A move of `attempt_id` is a join-condition column, so it goes into `moves`, a refill and a cascade.
- A write to the attempt resolves through the existing reverse route, within the held ids. These races are already pinned by the collection oracles (`conversations-oracle.test.ts:608-617`).
- One held tuple serves edited-files, allow-files and review.plugin-changes.
- `serveValue` re-runs `whileSubscribed` when a followed value changes, which fixes the latent "watch never re-points" bug.

**Review fixes folded in.**
- **Ledger freshness.** attempt-work's loader still calls `ensurePushLedgerFresh()` as the pull half, but in its own `recordEntrySpan("bg", "push-ledger.reconcile")`, so its reads and writes are not the loader's.
  - A conversation inserted into A changes `convIds`, which recomputes attempt-work, which reconciles, which writes `pushes`.
  - That write changes `pushIds`, which recomputes once more and converges. I5 holds.
- **commits-graph.** It drifted because `readLandedShas` → `workMemo` → `readContext` (`attempt-work/server/internal/work.ts:76-98`) issued direct SQL inside commits-graph's loader.
  - Split `readContext` into `attemptWorkFrom(facts)`, plus `readAttemptFacts` (direct SQL) for the non-resource caller (drop-and-exit).
  - commits-graph follows `attemptWorkServed` and `attemptWorkspaces`.

**Migration** (session 2):

| Value | Follows (new collections in bold) | `reads` removed |
|---|---|---|
| attempt-work | `attemptWorkspaces` (pick gains `worktreePath`, `createdAt`), **`attemptConversationIds`** (scoped all, `conversations` by `attemptId`, id only), **`attemptPushIds`** (scoped all, `pushes`), **`attemptDeliveries`** (lookup, pk `attempt_id`) | all 4 |
| commits-graph.graph | `attemptWorkServed`, `attemptWorkspaces` | `_attempts`, `_conversations`, `pushes` |
| edited-files, allow-files, review.plugin-changes | **`conversationWorkspaces`** | `_conversations`, `_attempts` |
| jsonl-events, background-shell-output, subagent-activity, subagent-transcript | **`conversationSessions`** (scoped all, `conversation_sessions` by `conversationId`, order `seenAt`; single pk), **`conversationSessionId`** (lookup, `conversations` → `claudeSessionId` only, so the gate skips other columns) | `transcriptChainReads` deleted; `resolve-chain.ts` takes facts |

`findWorkspaceOfConversation` (raw SQL, kept to avoid a cycle) stays only for non-resource callers.

### D. Composite keys (session 3)

**One key codec** in `query-resource/core/internal/composite-key.ts`, shared by web and server:
- `compositeKey(["dataViewId","viewId","rowKey"])` percent-encodes each part and joins with `/`. `,` is always encoded, so `isPointId` and comma-joined point sets keep working.
- Parts must be text, uuid or int base columns.

**Runtime (S3, approved).**
- `HostMap.identity.columns` plus the codec.
- `valuesOf` reads N carried columns at the selected row indices and encodes them.
- `tableLayoutRequirements` carries every part.
- The refill renders `(a,b,c) IN (VALUES …)` from the decoded keys.

**Trigger (change-feed).**
- `TG_ARGV[0]` becomes a JSON list of pk columns.
- `old_rows` / `new_rows` pair `USING (pk…)`, so composite tables gain `unchanged` gating and `moves` demotion.
- `ids` stays NULL for composite tables.
- The A3 layout check (`route-layout.ts`) learns the list form.

**Migration** (scoped `all` on the pk's leading prefix):

| Value | Scope | Key |
|---|---|---|
| data-view-row-order | `dataViewId, viewId` | `[dataViewId, viewId, rowKey]` |
| data-view-custom-values | `dataViewId` (adds order `rowKey, columnId`) | `[dataViewId, rowKey, columnId]` |
| active-data.bindings | `conversationId` | `[conversationId, messageId, tag, occurrenceIndex]` |
| sonata trackViews | `songId` | `[songId, trackId]` |
| agent-notes-authors | `blockId` (order `createdAt, conversationId`) | `[blockId, conversationId]` |

Consumer changes:
- `useActiveDataBinding` becomes `useLiveRow` on the encoded key.
- `useRowOrder` and `useCustomColumnValues` keep their map projections over `useLive(c, { where })`.
- trackViews' detached lane goes through `resolveOptimisticSource`.

### Out of scope

These stay whole-table, which is the honest answer for them: totals, top-N, search and singletons (`notifications.unread`, `browser-recents`, `search.results`, the chord singletons, `mail.*`, `event-triggers`, the reports scope, the saved icon sprites).

Candidates for a later `follows` pass, listed in the session 3 notes: `task-source-url`, `subjectTask`, `history.version`, `attachment-file`, `claude-cli.calls-for`, the deploy SSH key, `attachments.by-owner`, `events.run-events`.

## Measurement (before/after, required by the track)

**Script:** `plugins/network/plugins/live/e2e/narrowing.ts`, forked from `jsonl-viewer/e2e/no-op-frames.ts`.
- It drives a raw `/ws/notifications` socket and uses the e2e-harness helpers.
- It reads params from the core descriptors, so one script runs on both builds.
- It is added and run on a merge-base build first: the baseline.

**Subscriptions:**
- page-blocks P1–P3, with acks on P1;
- attempt-work and commits-graph for A;
- edited-files, allow-files and plugin-changes for C;
- the 4 transcript values for C;
- from session 3, row-order, custom-values and bindings.

**Phases:** 10 writes each, 300 ms apart, median of 3 runs.
- *Unrelated:*
  - block patches on P9;
  - `POST /api/conversations/:other/viewed`;
  - a title edit on another task;
  - row-order drags in another data view.
- *Related:*
  - typing-projection patches plus one structural op on P1;
  - C's own `viewed` (gated);
  - an insert of a conversation into A;
  - a session-chain insert for C;
  - a fixture re-point of C's `attempt_id` (the hop).

**Per key and phase, report:**
- Δ loads, from `get_runtime_profile` `byParent`, push parent only;
- Δ `notifyStats.feed`;
- frames by kind, and their total characters;
- `deliver:page-blocks` count and `measuresMax.frameChars`;
- the B counters (split-ack, open xid);
- `ackOverflow`;
- NOTIFY bytes on bulk statements, and how many fall back to FULL over the cap.

**Pass criteria:**
- *Unrelated phases:* 0 loads, 0 feed and 0 update/invalidate frames on every migrated key. P1 may receive acks.
- *Related phases:* at least 1 update per expected key. A page-blocks typing frame is about one block's JSON (record it), against the baseline of 40,589 (last) to 102,173 (max) characters. The hop write reaches all 3 followers through 1 refill.

**Bench:** `change-feed/scripts/txn-end-bench.ts` runs 2000 single-row transactions with and without the marker trigger, and reports p50/p95 commit latency.

**Results** go into this doc's "As landed" sections and the track header, per the track's perf rule.

## Sessions

**Session 1: scoped `all`, the marker, page-blocks.**
1. Add the measurement script and run the baseline.
2. Change-feed marker trigger and the xid-holding burst router, with tests.
3. The `by` declaration, compile and `useLive { where }`.
4. `resolveOptimisticSource` and the scoped optimistic forms.
5. The C39 step (A.4).
6. The page-blocks migration and its 7 sites.
7. Build, then check `_debug`: `identity` routes with `match`, no `full` page-blocks route.
8. Run the after-measurement, then the docs.

**Session 2: `follows`.**
- S2 runtime edge.
- The 6 new follow-target collections.
- The `readContext` / `resolve-chain` refactors and the ledger span.
- `whileSubscribed` re-run.
- 9 values migrated, then measure.

**Session 3: composite keys and the 5 composite values.**
- S3 codec and runtime, the composite trigger pairing, then measure.
- Delete the "whole-table until it reads through a collection" reasons.
- Update the track header.

**Tests**
- query-resource:
  - `routes.test.ts` / `compile-alias.test.ts`: the match emitted equals the SQL's eq, and every refusal.
  - The scoped-oracle suites, extended with param'd `all` (moves, deletes, over-cap, trash/restore).
- resource-runtime:
  - A new `runtime-follows.test.ts`:
    - a held tuple is reached with no socket;
    - a cascade fires only on a change;
    - one load per flush;
    - a double route is refused;
    - the hop move and the reverse race;
    - convergence under random interleavings, via `makeClientView`.
  - `routing-layout.test.ts`: composite carry.
- change-feed:
  - `listener.test.ts`: one transaction of about 2000 NOTIFYs across socket reads routes as one burst after `$end`; the loud reports.
  - `burst.test.ts`: the xid hold, no-xid changes, every loud case.
  - `routed-trigger.test.ts`: composite pairing.
- optimistic-mutation `overlay.test.ts`: scoped deltas without a watermark confirm by ack.
- C39 harness case for each converted key.
- Run with `./singularity test <paths>`, plus `./singularity check`.

**Docs to update:**
- the CLAUDE.md of network/live, query-resource, resource-runtime, change-feed, optimistic-mutation and page/editor;
- the "As landed" sections of `…-declared-reads-for-db-values-v2.md` (limits closed);
- the track header and progress list;
- at the end, file one next-main task with the page id.

## Risks

- **A large page's structural edits ship the full `order`**, about 80 KB at 2000 blocks. That is still better than today's forest on every keystroke. A positional order op in the protocol is a possible follow-up.
- **The marker costs one deferred trigger per statement and one NOTIFY per transaction.** The bench measures it. A `SET CONSTRAINTS ALL IMMEDIATE` would put the marker early. There is no use of it today, and a violation is reported loudly through `split-ack`.
- **Carrying `page_id`, `attempt_id` and composite parts makes bulk statements hit the 7000-byte FULL fallback sooner.** That is sound but slower, so it is measured.
- **Held tuples cost memory per follower tuple.** Each is a one-row point or a handful of rows. An upstream load error surfaces as the follower's error, never as a stand-in value.
- **Old bundles:** settled by the C39 step per key.

## As landed — session 1 (2026-10-19, worktree `att-1792357493-oxftyu`)

**B — end-of-transaction marker** (`database/change-feed`). `live_state_txn_end`
is a deferred constraint trigger on `live_state_changelog`, emitting
`pg_notify('live_state_end', {x, n})` once per transaction (guarded by the
transaction-local `live.txn_end` setting); part of the shared layer
(fingerprinted, re-verified from the catalog, created only when missing). The
listener LISTENs on both channels in one statement. `burst.ts` holds a change
carrying an xid until its end and routes the whole transaction from one
macrotask; four problems are reported (filed once per kind as
`ChangeFeedTxnEndError`), then routed — never dropped: `change-after-end`,
`over-count`, `interleaved`, `txn-end-missing` (no change for 2 s — the
deadline runs from the LAST change received, re-armed for the remainder). A
retired socket or `stop()` releases the open xid unreported and holds nothing
until a socket LISTENs again. `installFeed` refuses any other deferred trigger
on a covered table or the changelog. The catch-up replay is unchanged.

**A1 — `all: { by }`** (`query-resource` + `network/live`). One loop
(`scopeOf`) emits the SQL `col = $param`, the base identity route's `match`
and each tuple's use match + moves. Scope columns: plain text / varchar, uuid,
smallint / integer / bigint base columns — a decoded (`parsedText` /
`parsedJson`) column is refused, as are joins, expressions, timestamps,
floats. The server `validateParams` requires each param in its column type's
canonical text (lower-case uuid, canonical in-range decimal), so the SQL's eq
and the router's key match agree exactly. Unscoped sets are byte-identical
(golden unchanged). Read: `useLive(c, { where: { pageId } })`.

**A2 — optimistic + page-blocks.** `resolveOptimisticSource(source, query)`
(`optimistic-mutation/web/internal/source.ts`) is the one lane derivation for
the hook and both detached enqueues; scoped form `useOptimisticResource(c,
{ where }, opts)`. `pageBlocks` is `liveCollection("page-blocks.v2", { all: {
by: ["pageId"] } })` — renamed (C39): an old tab parses the first frame but
throws on the first keyed delta and freezes, so the old key is refused as skew
instead (pinned by `page-blocks-oracle.test.ts` and
`web/__tests__/page-blocks-old-tab.test.ts`). Every consumer migrated
(editor stores, version preview, outline; `useBlockCrumb` → `useLiveRow`).

**Measured** (`network/live/e2e/narrowing.ts`, 10 writes per phase, 3 pages held):

| Write | Key | Before | After |
|---|---|---|---|
| block on a page nobody holds | page-blocks | 30 loads, 30 updates, 3,760,652 chars | 0 loads, 0 frames |
| block on the held page | page-blocks | 10 full frames, 1,295,248 chars (max 129,526) | 10 deltas, 11,535 chars (max 1,155) |
| `viewed` on other conversations | attempt-work / commits-graph / allow-files | 10 loads each (5.3 KB / 137 KB / 2.5 KB) | unchanged — session 2 (`follows`) |
| `viewed` on other conversations | jsonl-events / subagent-activity | 10 loads, 0 frames | unchanged — session 2 |
| another task's title | all | 0 | 0 |

**Not done in session 1:** the `ackOverflow` `_debug` counter (resource-runtime
is framework; needs approval); per-kind counters for the burst router (it
reports, nothing reads a count); a skip state for a scoped read whose scope is
not known yet (`useLive(c, null)` is the count kind's skip today); `withWire`
fields on a scoped set; the commit-latency bench for the marker. Found, not
ours: in a full `./singularity test plugins/page/plugins/editor` run, 15 tests
in 7 files fail order-dependently because `collectContributions` replaces the
test preload's host-service providers (server-core, likely since `717f488f45`).
