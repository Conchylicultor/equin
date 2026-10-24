# Bounded working-set — Phase 2: flat lists + twins (+ mutation-ack channel)

**Parent:** [`research/2026-07-18-global-bounded-working-set-resource-contract.md`](./2026-07-18-global-bounded-working-set-resource-contract.md)
(the contract; Phase 0 + Phase 1 pilot trio landed — see its Implementation log). This doc is the
Phase 2 execution plan.

## Context

The boot snapshot still ships several unbounded flat collections to every client. Fresh serialized
measurement (main, 2026-07-18, `GET /api/resources/boot-snapshot`, total **5.0 MB**, 19 resources —
ranked by SERIALIZED size per the recorded lesson, not `pg_column_size`):

| Resource | Serialized | Rows | Shape today |
|---|---|---|---|
| `attempts` / `tasks` | 1.90 MB / 1.76 MB | 3,574 / 3,814 | **deferred trees** (out of scope, recorded decision) |
| `conversation-preprompts` | **615 KB** | 365 | record `{convId → {prepromptId,title,text,icon,…}}`, mode:"push", bootCritical |
| `conversation-progress` | **315 KB** | 2,616 | queryResource array, bootCritical — the designed point-twin of categories |
| `queue-ranks` | **158 KB** | 2,726 ranks | ONE push value `{ranks[], pinnedConversationId}`, bootCritical; only ~26 conversations live |
| `agents` | 53 KB | 74 | user-curated TREE (parentId/rank) — deferred with the trees (decision below) |
| `conversation-notes` | **21 KB** | 104 | record push, bootCritical |

Beyond boot payload: all four migration targets are bootCritical ⇒ FULL recompute + full jsonb
persist on every change. Worst: `seedRankJob` fires on **every conversationCreated** → full
2,726-row re-select + ~158 KB persist + full broadcast, to serve a queue that reads ~26 rows.

**Consumer reality (exploration 2026-07-18):** every consumer of preprompts/progress/notes reads
exactly ONE conversation's row (header chip, sidebar row marker, notes editor). The queue consumer
(`useQueueRows`) needs ranks only for the **live** conversation set it already subscribes to via
`conversations-active`. None needs the whole collection.

## Decisions (user, 2026-07-18)

1. **Queue reorder confirmation → mutation-ID ack channel** (the Replicache/Zero `lastMutationID`
   shape adapted to this wire): scoped/point deltas can't carry the snapshot watermark (Rule B′),
   so instead of per-consumer content-based confirmation hacks, build the structural ack channel
   benefiting ALL optimistic consumers. Designed by a dedicated agent — design summary in §C,
   full detail below.
2. **`agents`: defer** into the windowed-tree follow-up (tree-shaped like tasks/attempts,
   user-bounded at ~74 rows). Not migrated in Phase 2.
3. **`conversations_ext_queue` retention sweep: include** — `defineRetention`-based sweep of rank
   rows whose conversation is long gone.

## Part A — three point migrations (categories-pilot template, hook signatures preserved)

Reference: the categories pilot diff (4 files: shared descriptor → `pointQueryResourceDescriptor`,
server → `windowQueryResource(…, {point:{by: t.parentId}})`, web hook → `usePointResource`,
CLAUDE.md). Point resources are never bootCritical (recorded decision: post-mount hydration);
bounded resources are never L2-persisted; `clearSnapshotsExceptKeys` sweeps their stale snapshot
rows at boot automatically.

### A1. `conversation-progress` (mechanical twin — do first)

- `plugins/conversations/plugins/conversation-progress/shared/schemas.ts` —
  `queryResourceDescriptor(…, {bootCritical:true})` →
  `pointQueryResourceDescriptor<ConversationProgress>("conversation-progress", ConversationProgressSchema, "conversationId")`.
- `…/server/internal/resource.ts` — `queryResource` → `windowQueryResource`; drop
  `orderBy: asc(parentId)`, add `point: { by: conversationProgress.table.parentId }`.
- `…/web/internal/use-progress.ts` — `useResource(…).data.find(…)` →
  `usePointResource(conversationProgressResource, conversationId)`; return `data ?? null`.
- Consumers (`progress-bar-toolbar.tsx`, `progress-bar-row.tsx`): unchanged.

### A2. `conversation-preprompts` (record→row payload change)

- `plugins/conversations/plugins/conversation-preprompt/shared/schemas.ts` — delete
  `ConversationPrepromptsPayloadSchema`/`…Payload` (the `z.record`); descriptor →
  `pointQueryResourceDescriptor<ConversationPreprompt>("conversation-preprompts", ConversationPrepromptSchema, "conversationId")`.
- `…/server/internal/resource.ts` — delete the hand-written push record loader →
  `windowQueryResource(descriptor, { from: t, select: { conversationId: t.parentId, prepromptId,
  title, text, icon, updatedAt }, point: { by: t.parentId } })`. The `icon` jsonb (`AvatarSpec`)
  projects as a plain column (add a compile test).
- `…/web/internal/hooks.ts` — `useConversationPreprompt` → `usePointResource`; signature
  (`ConversationPreprompt | null`) preserved; consumers (`preprompt-chip`, `preprompt-list-icon`,
  `preprompt-icon`) unchanged.
- Write path (`record.ts`/`record-job.ts`) unchanged — the entity-extension upsert on
  `conversations_ext_preprompt` point-routes via the change-feed (categories/progress precedent).

### A3. `conversation-notes` (record→row + editable-state hook)

- `plugins/conversations/plugins/conversation-view/plugins/notes/shared/schemas.ts` — delete the
  record payload schema; descriptor →
  `pointQueryResourceDescriptor<ConversationNote>("conversation-notes", ConversationNoteSchema, "conversationId")`.
- `…/server/internal/resource.ts` — push record loader → `windowQueryResource(…, { from: t,
  select: { conversationId: t.parentId, notes, updatedAt }, point: { by: t.parentId } })`.
- `…/web/internal/use-conversation-note.ts` — ONLY the `serverNote`/`pending` derivation changes:
  `usePointResource(conversationNotesResource, conversationId)`; `serverNote = data?.notes ?? ""`.
  The `useEditableField` layering (debounce, flush-on-blur, echo-suppression) is untouched — the
  save echo now arrives as a single-row point delta on this tuple (strictly less noisy). Routes
  unchanged.

## Part B — `queue-ranks` split (the crux)

Split the one `QueueData` push value into two resources
(`plugins/conversations/plugins/conversations-view/plugins/queue/`):

### B1. Point ranks + scalar pin

- `core/resources.ts`:
  - `queueRanksResource` → `pointQueryResourceDescriptor<QueueRankRow>("queue-ranks",
    QueueRankRowSchema, "conversationId")`. Keep `QueueData`/`QueueDataSchema` as the
    *client-assembled* input type of `classifyQueue` (no longer a wire shape).
  - NEW `queuePinResource = resourceDescriptor("queue-pin",
    z.object({ pinnedConversationId: z.string().nullable() }), { pinnedConversationId: null },
    { bootCritical: true })` — a schema-bounded 1-row scalar (the `build.mainAheadCount` allowed
    shape). Pin stays correct at first paint.
- `server/internal/resource.ts`:
  - ranks → `windowQueryResource(queueRanksDescriptor, { from: conversationsQueue.table,
    select: { conversationId: t.parentId, rank: t.rank }, point: { by: t.parentId } })`.
  - pin → `defineResource(queuePinDescriptor, { mode: "push", loader: async () =>
    ({ pinnedConversationId: await getPinnedId() }) })` — read-set `queue_state` (1 row).
  - Preserve the "deliberately no dependsOn on conversations" property (point routing gives it
    structurally).

### B2. Consumer rewire (`…/data-view/plugins/queue/web/components/use-queue-rows.ts`)

```ts
const liveIds = useMemo(() => (activeResult.pending ? [] :
  activeResult.data.map((c) => c.id)), [activeResult]);          // point.encode sorts+dedupes
const ranksResult = useOptimisticResource<QueueRankRow[], ReorderVars>({
  resource: queueRanksResource,
  params: queueRanksResource.point.encode(liveIds),
  apply: applyReorder,                                            // rows→rows (B3)
  mutate: (vars) => fetchEndpoint(reorderQueue, {}, { body: vars }),
  // confirmation: mutation-ack channel (§C)
});
const pinResult = useResource(queuePinResource);
// useCombinedResources({active, gone, ranks, pin, tasks}) → reassemble
// QueueData {ranks, pinnedConversationId} client-side → classifyQueue UNCHANGED.
```

- **Flash mitigation** (new re-subscription pendings when the live set changes): retain the last
  non-pending classified rows while `all.pending && last != null` (~5 lines in `useQueueRows`).
  Boot: ranks arrive one RTT post-mount; the existing all-or-nothing gate shows the loading
  skeleton for that RTT (no wrong-order flash), pin is bootCritical so the Current section is
  right immediately.
- **Known edge (accepted):** `useOptimisticResource` re-baselines on `(key, params)` change —
  a reorder dispatched in the same instant a conversation enters/leaves the live set drops its
  overlay early; the mutation already POSTed, server truth lands one RTT later.

### B3. `apply-reorder.ts` — rows→rows

`applyReorder(rows: QueueRankRow[], vars): QueueRankRow[]` (drop the `{…data, ranks}` wrapper; the
pin was never touched by reorder). Adjacency now computes over LIVE rows only — matching the
server's live-filtered `rankAdjacentTo`, fixing a latent prediction/server mismatch (today's
client predicts against 2,726 rows incl. stale ranks of gone conversations). `OpNoLongerApplies`
on missing dragged/target id unchanged (now also fires when the target left the live set).

### B4. Retention sweep (decided: include)

`defineRetention` (`plugins/infra/plugins/retention`) sweep on `conversations_ext_queue`: delete
rank rows whose parent conversation has been `gone` past a TTL (e.g. 30 d). The rank is
launch-time-seeded and meaningless once the conversation left the queue; FK CASCADE already
covers hard deletes. Server-side only; no resource impact (the point loader never reads them).
Note: `defineRetention`'s plain `column < now()-ttl` shape may need the join-style variant — if
it only supports single-table TTL columns, add the sweep as a `defineJob` following retention's
nightly pattern and note why.

## Part C — mutation-ack channel (`ackTx`) on the delta wire

The structural replacement for exact optimistic confirmation once value snapshots (and their
Rule B′ watermarks) stop shipping on scoped/point deltas. Full design (Fable design agent,
2026-07-18); implement as specified.

### C0. Shape decision — exact per-frame txid set, not lastMutationID, not sourceTxMax

- **True per-client `lastMutationID`** (Zero/Replicache literal) rejected: needs a client mutation
  counter + per-client server registry + a mutation funnel — fights the architecture (writes are
  ordinary HTTP endpoints).
- **Monotone `sourceTxMax` high-water mark** rejected as **unsound**: xid8s are assigned at first
  write but commit out of order — `sourceTxMax=105` does not prove tx 100 (committed later) is
  folded in. The snapshot watermark dodges this only because `pg_snapshot_xmin` is a true
  visibility floor — exactly the claim a scoped recompute cannot make (that's why Rule B′ exists).
- **Chosen: `ackTx: string[]`** — "the source-transaction ids of the DB changes folded into this
  recompute for this `(key, params)` tuple". The change-feed trigger already runs
  `pg_current_xact_id()` (stored in the changelog; only the NOTIFY payload omits it), and every
  mutation endpoint already returns `currentTxId(tx)` as the op's `ackWatermark`. Correlation is a
  pure client-side join on txid: server broadcasts which txids a frame folded; each client matches
  against its own pending ops' tokens. No per-client server state; set membership is
  order-independent (strictly stronger than "everything ≤ N"); Zero-compatible (`ackWatermark`
  plays the client-mutation-ID role, `ackTx` plays `lastMutationID` delivery).

**Why `ackTx` on a scoped delta doesn't violate Rule B′:** it claims only *"for W ∈ ackTx: every
row of this tuple's view that W wrote has been re-read post-commit and is reflected in the merged
base"* — nothing about membership/order completeness, nothing about other transactions. It can
confirm the op whose token equals W; it can never deny. Denial stays snapshot-watermark-only
(Rule B′ coexists unchanged). The one soundness hazard — a push-path drain **joining a read
flight whose SELECT ran pre-commit** — is closed with the existing flight co-production idiom:
the pending's txids seed the flight, the drain stamps the **flight-resolved** ackTx, a joiner
adopts the starter's (typically empty) set. Missed ack = safe backstop degrade; false ack =
structurally impossible. Membership/scoped refills never coalesce (ctx loads bypass the
inflight) — inherently safe.

### C1. Wire and type shapes

```ts
// Existing frames gain one optional field (feed-driven recomputes only):
| { kind: "update"; …; watermark?; ackTx?: string[] }
| { kind: "delta";  …; watermark?; ackTx?: string[] }
// NEW standalone frame — for recomputes producing no value change (empty scoped
// diff, net-zero coalesce, window boundary skip, point empty-intersection).
// Version-less, cache-less, idempotent; gated on the local sub entry; MUST NOT
// bump the version counter.
| { kind: "ack"; key: string; params: ResourceParams; ackTx: string[] }
```

`invalidate` frames NEVER carry `ackTx` (base doesn't yet reflect the tx — stamping would drop
overlays pre-refetch, a transient revert). `sub-ack`/HTTP bodies don't need it (their snapshot
watermark subsumes it).

Change-feed NOTIFY payload (`change-feed/server/internal/triggers.ts`, both emit sites incl. the
over-cap re-emit): add `'x', pg_current_xact_id()::text`. `DbChange` (`parse-payload.ts`) gains
`xid: string | null` (absent → null, tolerant of pre-upgrade NOTIFYs). `route-change.ts` forwards
it on both applies. DDL is CREATE OR REPLACE per boot — no migration.

Runtime (`resource-runtime/core/runtime.ts`):

```ts
applyDbChange(change: { …; xid?: string }): void
type RecomputeIntent = { …; delta: { table; ids; op; xid?: string } | "FULL" };
interface PendingNotify {
  …;
  sourceTx?: Set<string>;      // unioned on EVERY merge incl. FULL absorb/degrade
                               // (a FULL recompute reads post-commit — claim survives;
                               // contrast `deleted`, which FULL drops). Cap 64.
  sourceTxOverflow?: boolean;  // overflow ⇒ ship NO ackTx that cycle (missing ack
                               // is safe; a torn set is not).
}
interface ResourceDefinition<T, P> { …; ackChannel?: true; }  // opt-in for standalone
// ack frames only; value-frame ackTx is unconditional (free bytes, no extra frames).
```

Client registry (`live-state/web/tx-ack-registry.ts`, NEW — sibling of `watermark-registry.ts`,
module-level for the same reason: synchronous reads inside QueryCache callbacks):

```ts
const ACK_RING_CAP = 256;    // per-(key,paramsKey) insertion-order ring
noteResourceTxAcks(key, params, txids): void
hasResourceTxAck(key, params, txid): boolean
subscribeResourceTxAcks(listener): () => void   // fires AFTER acks noted, standalone frames only
```

### C2. Server capture points (~15 lines change-feed, ~90 runtime)

1. `applyDbChange` passes `sourceTx: change.xid` into `scheduleNotify`. **Point
   empty-intersection**: today `continue`; when `entry.ackChannel && change.xid`, instead
   `scheduleNotify(entry, params, EMPTY_SET, {source:"feed", sourceTx})` — an ack-only pending.
2. `mergePending(…)` unions `sourceTx` in every branch (incl. FULL absorb/degrade); enforces cap.
3. `cascadeDownstream(…)` threads the upstream pending's set into downstream `mergePending`
   (a `SKIP_EDGE` relevance skip drops it — vacuously irrelevant downstream, missing ack safe).
4. `getResourceValue(…, seedAckTx?)` — flight factory closes over seedAckTx, resolves
   `{value, etag, watermark, ackTx: seedAckTx}`; joiners adopt the STARTER's ackTx
   (co-production, the stale-flight fix). ctx (scoped) loads return seedAckTx directly.
5. Drains: `drainEntry` FULL — seed the flight, stamp flight-resolved ackTx on `update`/FULL
   delta; scoped branch — stamp `[...sourceTx]` on the scoped delta, and when
   `upserts.length===0 && ackChannel && sourceTx?.size && subs.length` send `{kind:"ack"}`
   (no version interaction). `drainMembershipFull` — same as FULL. `drainMembershipScoped` —
   stamp on the `changed` delta; in `!changed` (net-zero, boundary skip) and the
   `requestedIds.size===0 && deletedIds.size===0` early return (point ack-only pending):
   `ackChannel` ⇒ broadcast `{kind:"ack"}`, never bump version/snapshot/cascade. Loader failure ⇒
   frame + acks dropped together (no false ack). Hand `notify()`/synthetic paths carry no
   sourceTx — structurally ack-less (correct: no HTTP mutation corresponds).
6. Plumb `ackChannel`: ResourceDefinition → ServerResourceOptions → contractToDefinition →
   RegistryEntry; `BoundedQueryResourceSpec` gains `ackChannel?: true` pass-through in
   `compileBoundedServerOpts` (query-resource `spec.ts`/`compile-window.ts`).

### C3. Client bookkeeping (~70 live-state, ~70 optimistic-mutation)

- `notifications-client.ts`: extend `ServerMsg`; handle `"ack"` BEFORE the version-guard block
  (no version), gated on the local sub entry like `sub-error`; `noteResourceTxAcks` then registry
  emit — no cache write, no markApplied, no version adoption. `applyUpdate`/`applyDelta`: note
  acks at the exact point `noteResourceWatermark` is called — before `setQueryData`, after
  parse/merge success. A delta that dead-ends in `forceFullResub` never notes its acks. Export the
  three registry fns from `web/index.ts`.
- `optimistic-mutation/web/internal/overlay.ts`: `confirmPass`/`resolvePass` gain
  `hasAck: (txid) => boolean | undefined`; ONE added confirmed-arm (both modes):
  `op.resolved && op.ackWatermark !== undefined && hasAck?.(op.ackWatermark)` (feeds the
  same-target cascade in content mode). NEW `ackPass(pending, hasAck, sameTarget?)` — drops
  acked resolved ops, runs the cascade, counts NO miss, denies NOTHING.
- `use-optimistic-resource.ts`: build `hasAck` from the registry with `paramsRef.current`; pass
  into both existing edges (QueryCache subscription + `runMutate` resolve handler — the resolve
  edge closes the delta-before-HTTP-response race); new effect subscribing
  `subscribeResourceTxAcks` → run `ackPass` when the tuple matches and ops are pending.
  **Public API unchanged** (`mutate` already returns `{watermark}`).

### C4. Confirmation rule (precise)

A resolved op with token `W` leaves the overlay on the FIRST of, evaluated on the push edge, the
resolve edge, and the ack edge:

1. **Exact ack** — `W ∈ ackRegistry(key, params)`.
2. **Causal (Rule B, unchanged)** — a full-reconcile snapshot watermark strictly past `W`.
3. **Content / same-target cascade (unchanged)**.
4. **Tokenless coarse (unchanged)** — only for ops with no watermark.

Denial: exactly as today (content mode + snapshot watermark past `W` + isConfirmedBy still
rejecting). `ackTx` never denies.

Race matrix (all outcomes verified in design): delta-before-HTTP-response → registry remembers,
resolve edge confirms; HTTP-first → push edge confirms; N in-flight mutations → per-op set
membership, order irrelevant, coalesced frame carries both txids; no-byte-change/boundary-skip/
outside-tuple write → standalone ack frame (never hangs); reconnect sub-batch replay → acks don't
survive replay by design, fresh sub-ack watermark confirms via Rule B (residue: an ack-only
change whose ack frame was lost to a disconnect leaves a no-op overlay until the next full
frame/resub — never a revert, documented + bounded); params re-baseline mid-flight → new tuple's
sub-ack watermark backstops (registry is namespaced per paramsKey — wrong confirmation impossible
in either direction); server restart → xid8s are DB-global, resub watermark covers; xmin held
back by a long-running tx → irrelevant for exact ack (the historical Rule B weak spot);
stale-flight join → ships un-acked, backstop confirms.

### C5. Back-compat + rollout

Value-frame `ackTx` is inert for all non-optimistic consumers; watermark consumers byte-identical;
central runtime (no feed) never produces it. Standalone `ack` frames are per-resource opt-in
(`ackChannel: true`, initially only queue-ranks). Stale pre-upgrade tab receiving `{kind:"ack"}`
hits the residual `applyInvalidate` arm (one spurious refetch) — non-issue since tabs reconnect on
deploy.

**Step A (channel) ships before Step B (queue point migration)**: with queue-ranks still a push
struct, its update frames already carry ackTx (feed-driven), so queue confirmation upgrades from
watermark-compare to exact-ack BEFORE the migration — no confirmation gap between steps.

No schema migrations, no new tables, no client-API change.

## Explicitly out of scope (Phase 2)

- `tasks`/`attempts`/`agents`(+`agent-launches`) — the tree resources; windowed-tree hydration is
  a dedicated follow-up design (recorded decision). After Phase 2 the boot payload is dominated by
  exactly these (~3.7 MB of the remaining ~3.75 MB).
- The `pushes`→commits-graph id-routing follow-up (Phase 1 log).
- `worktree-ops`, `turn-summaries`, `conversations-gone*`, `build.*`, `release.previews` — small
  or already bounded; Phase 3 ranking decides.

## Ordered implementation sequence

1. A1 progress (validate the template end-to-end) → A2 preprompts (jsonb icon projection) →
   A3 notes (editable-field composition). Independent of C/B; can proceed in parallel.
2. Part C Step A — the ack channel (change-feed `x` → runtime sourceTx/frames/co-production/
   `ackChannel` → client registry/frames → overlay/hook). queue-ranks (still push) upgrades to
   exact-ack confirmation immediately, de-risking step 3.
3. Part B queue split (B1 resources w/ `ackChannel: true` → B3 applyReorder rows→rows → B2
   rewire → B4 sweep). The design's open question "pin placement" is resolved: separate
   `queue-pin` scalar resource (B1).
4. CLAUDE.md `Resources:` lines for all touched plugins; `./equin build`; re-measure.

## Verification

1. Suites: `bun test plugins/framework/plugins/resource-runtime/core`,
   `bun test plugins/infra/plugins/query-resource`,
   `bun test plugins/primitives/plugins/live-state/core`,
   `bun run test:dom plugins/primitives/plugins/live-state plugins/primitives/plugins/optimistic-mutation`.
   Extend: `compile-window(.test|-runtime.test).ts` (jsonb `icon` projection; the three new point
   specs), `runtime-window-membership.test.ts` (FK-CASCADE `op:"D"` → point delete on a multi-id
   tuple; id-set change teardown/load), `window-hooks.test.tsx` (row-or-null settle for the
   note/preprompt hooks). New: `apply-reorder.test.ts` (rows→rows), a `use-queue-rows` jsdom test
   (pin + ranks tuple + retain-last-rows: no skeleton flash on re-sub), optimistic-mutation
   point-base + ack-confirmation tests (per Part C design).
2. `./equin build` → worktree: `_debug` shows the 4 keys as point membership (no
   `recompute:{full}`), `live_state_snapshot` rows for them swept at boot, `queue-pin` persists a
   1-row value.
3. Re-measure `GET /api/resources/boot-snapshot` serialized per-key (script: curl + rank by
   `len(json.dumps(value))`): expect preprompts/progress/queue-ranks/notes (~1.1 MB) gone; total
   ≈ 3.9 MB dominated by the deferred trees.
4. Behavior: queue drag-reorder confirms without flicker (ack channel); notes editor round-trips;
   preprompt chip + sidebar icons hydrate post-mount; seed-rank on conversationCreated ships a
   single-row point delta (live-state trace / churn monitor), zero persist.
5. `benchmark_boot` MCP + `get_runtime_profile` before/after for the migrated keys.

### Ack-channel test plan (Part C — from the design)

- NEW `resource-runtime/core/runtime-ack-channel.test.ts` (extend the fake-injection harness;
  `applyDbChange` gains `xid` in `test-support` call sites): feed-change xid → FULL delta/update
  carries ackTx, hand-notify/synthetic none, invalidate never; coalescing (two xids → one frame
  with both; scoped+FULL-degrade keeps both — contrast `deleted`-drop); scoped empty diff ⇒
  `{kind:"ack"}` iff `ackChannel`, no version bump; point empty intersection ⇒ ack frame iff
  opt-in; window boundary skip ⇒ ack frame, no version bump; **stale-flight join** via
  `controllable()` (joiner ships NO ackTx; starter flight carries it — mirrors the
  runtime-revalidate etag co-production case); loader failure ⇒ no frame no ack; cap overflow ⇒
  ackTx suppressed.
- `runtime-watermark.test.ts`: ackTx and watermark independent (scoped delta: ackTx yes,
  watermark never). `runtime-cascade-attribution.test.ts`: scoped cascade forwards sourceTx;
  `SKIP_EDGE` drops it.
- live-state DOM: `notifications-subs.test.ts` — ack frame gated on local sub; noted with no
  version adoption/cache write; delta acks noted BEFORE `setQueryData` (QueryCache listener reads
  `hasResourceTxAck` synchronously); drift-resub delta does NOT note acks. NEW
  `tx-ack-registry.test.ts` — ring bound, per-tuple namespacing, emit-after-note.
- optimistic-mutation: `overlay.test.ts` — exact-ack confirm in both modes; ack triggers
  same-target cascade; `ackPass` counts no miss / never denies / identity when unchanged;
  tokenless ops unaffected; denial still watermark-only. `use-optimistic-resource.test.tsx` —
  ack-before-resolve race; standalone-ack confirm with no cache event; params re-baseline then
  sub-ack-watermark backstop; sync-status unaffected by the ack edge.
- Queue (step B): reshaped `apply-reorder.test.ts`; `use-queue-rows` DOM test pinning tuple
  encode stability and reorder-confirms-via-ack under a watermark-less scoped delta.

## Implementation log (2026-07-18, this worktree — Phase 2 landed)

All parts implemented by parallel agents (A1/A2/A3 Opus, C Fable, B Opus); build green
(`checks ✓`), deployed, verified. Deviations from the plan, all sound:

- **A1–A3**: byte-faithful to plan; A2/A3 also pruned the deleted payload types from their
  `shared/index.ts` barrels; A2 added the jsonb-projection compile test; A3's jsdom case already
  existed (not duplicated).
- **C (ack channel)**: implemented as specified; interpretation calls: (1) registry listeners
  fire on every note (not just standalone frames) — idempotent, behavior-equivalent; (2) the
  pre-existing legacy scoped path's unobservable pre-diff version bump left as-is (ack frames are
  version-less; true no-bump pinned on membership paths); (3) `DbChange.xid` surfaced two extra
  call sites (listener fullSweep, snapshot catch-up replay) — both pass `xid: null` (synthesized
  recomputes, no source tx, missing ack safe); (4) a point ack-only pending hitting an evicted
  snapshot routes through the membership FULL branch and ships the ackTx on the full update
  (self-heal preserved). New `runtime-ack-channel.test.ts` (14 cases incl. stale-flight join).
- **B (queue)**: B4 sweep is a scheduled `defineJob` (nightly, main-only), NOT `defineRetention`
  — the rank side-table has no own timestamp/status; "gone past 30 d" needs the `_conversations`
  join the single-table TTL shape can't express (documented in-code). B2 dropped
  `useCombinedResources` (fresh-object return + retain-last set-during-render looped); replaced
  with a compound pending gate + memo over the five stable results, retain-last via guarded
  set-during-render. `liveIds` uses a null early-return (lint: `no-pending-data-collapse`).
- **Skipped (flagged)**: the `use-queue-rows` jsdom test — needs full fixtures for 5 rich-schema
  resources through NotificationsProvider; judged higher-risk than value. Candidate follow-up.

**Post-deploy validation**: boot payload **5.0 MB → 3.88 MB** (preprompts/progress/queue-ranks/
notes all gone; remainder = attempts 1.90 + tasks 1.76 + notifications 0.12 + agents 0.05);
`queue-pin` ships 40 B and persists 53 B; `live_state_snapshot` holds zero rows for the four
migrated keys; `_debug` shows all four as keyed with identityTable routing and queue-ranks with
empty dependsOn; smoke screenshot: queue sidebar renders Current/Queue sections with ranks, pin,
per-row progress bars + preprompt icons via point subs. One cold-boot burst of `element` slow-ops
(~1.5 s, count 1 each, host loadAvg 8.4 during concurrent builds) on the first paint — watch warm
loads; not recurring.

## Critical files

- `plugins/conversations/plugins/conversation-progress/{shared/schemas.ts,server/internal/resource.ts,web/internal/use-progress.ts}`
- `plugins/conversations/plugins/conversation-preprompt/{shared/schemas.ts,server/internal/resource.ts,web/internal/hooks.ts}`
- `plugins/conversations/plugins/conversation-view/plugins/notes/{shared/schemas.ts,server/internal/resource.ts,web/internal/use-conversation-note.ts}`
- `plugins/conversations/plugins/conversations-view/plugins/queue/{core/resources.ts,server/internal/resource.ts,web/…/apply-reorder.ts}`
- `plugins/conversations/plugins/conversations-view/plugins/data-view/plugins/queue/web/components/use-queue-rows.ts`
- Part C: `plugins/framework/plugins/resource-runtime/core/runtime.ts` (sourceTx plumbing, frame
  stamping, flight co-production, ackChannel, point ack-only routing);
  `plugins/database/plugins/change-feed/server/internal/{triggers,parse-payload,route-change}.ts`
  (the `x: pg_current_xact_id()::text` NOTIFY attribution);
  `plugins/primitives/plugins/live-state/web/notifications-client.ts` + NEW
  `web/tx-ack-registry.ts`; `plugins/infra/plugins/query-resource/server/internal/{spec,compile-window}.ts`
  (ackChannel pass-through);
  `plugins/primitives/plugins/optimistic-mutation/web/internal/{overlay,use-optimistic-resource}.ts`.
