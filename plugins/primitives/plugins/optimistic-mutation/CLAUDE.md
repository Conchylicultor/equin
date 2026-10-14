# optimistic-mutation

Reusable optimistic-mutation primitive layered on top of `live-state`. It gives
any surface reading a `liveValue` (or a `liveCollection`'s id set) immediate,
snap-free optimistic updates that reconcile cleanly with the authoritative
WebSocket push.

## Model: overlay / replay — and never-revert

Pending local mutations live **outside** the TanStack cache, in React state
colocated with the consumer. The rendered value is always

```
data = pendingOps.reduce(apply, serverTruth)
```

so when a WS push overwrites the cache key, `data` simply recomputes — replaying
the still-pending ops on the fresh base. No push can clobber the prediction,
because the prediction was never written into the cache. Never `setQueryData` a
prediction: live-state's push overwrites the whole key, version-gated and
uncorrelated with any client op, so a cache-write prediction would race exactly
like waiting for the refetch does.

The governing policy
(`research/2026-07-11-global-never-revert-optimistic-edits.md`, matching
Docs/Figma/Linear/Notion local-first semantics): **pending local edits are never
visually reverted.** An op leaves the overlay only for a *causal* reason **local
to itself** — provably absorbed (its own `isConfirmedBy` accepts the snapshot, or
an exact ack names its own commit) or provably superseded (a snapshot causally
past its commit lacks its effect). One op's evidence never speaks for another,
and no op leaves out of turn: see *The ordering rule* below. A failed
`mutate` is a sync-status state (the cloud icon), never an undo; a
non-confirming push is at worst a *report*, never an eviction. The CRDT text
lane (`page/editor`'s `live-state-yjs-provider.ts` — offline is `syncing`, bytes
buffer and retry push-based) implements the same policy for text; this primitive
is the structural lane's twin.

## Ops are an ordered fold, so their writes are an ordered stream

The rendered value is `pendingOps.reduce(apply, serverTruth)` — an **ordered
fold**. A consumer whose ops do not commute therefore needs the server to apply
them in the order they were issued, or server truth diverges from the prediction
and the op can never confirm. That is a property of THIS primitive, not of any
consumer.

The primitive already asserted it, on its failed-op retry drain:

> Ordering is load-bearing: structural ops depend on their predecessors'
> server-side effects (a second split targets the block the first one created),
> so a concurrent replay can land out of order and be durably rejected for a row
> that is merely not committed YET.

…and enforced it there while leaving **first dispatch** racing. Dispatch, `retry`
and the reconnect drain are now ONE mechanism: the **send lane**
(`web/internal/send-lane.ts`).

- **Per `(resource.key, paramsKey)`, module-level** — NOT a per-hook ref: two
  mounts on one tuple are two writers to one server-side entity, and a
  per-instance chain orders each only against itself. Key is canonical sorted-key
  JSON, so mounts that build `params` differently still share it.
- **Failure-proof.** It advances on settle, resolve *or* reject, so a durably
  rejected op cannot wedge its successors — while each send still returns its own
  true outcome, leaving classification / `failed` / `retry` / `savedAt` untouched.
- **An idle lane sends synchronously, then is reclaimed** — no latency and no
  microtask of skew when nothing precedes; and a lane with nothing unsettled
  constrains nothing, so the registry can't grow per tuple ever written.
- **Only the send is on it.** Overlay, React commits and both confirmation edges
  are off it: `confirmPass` fires from the QueryCache subscription at any time.
- **A write with no overlay can still join it**: `enqueueResourceWrite(resource,
  params, fn)` puts a plain thunk on a tuple's lane. Its fire-and-forget twin
  `enqueueDetachedWrite(resource, params, { label, describe, onRejected? }, fn)`
  owns the outcome nobody reads: an `EndpointError` (any status — a detached
  write has no Retry surface) is emitted on `optimisticRejectionSink`, any other
  failure is rethrown. It exists because the
  registry is module-level — a tuple with NO mounted hook still has a lane — so a
  write whose surface is unmounted, or whose effect no single tuple's overlay can
  predict, is *unordered* rather than merely unpredicted if it bypasses this.
  Ordering holds; there is nothing to predict. (Consumer: the page editor's
  detached undo/redo persist into a collapsed sub-page, and its cross-page drag.)
- **Head-of-line blocking is real and deliberately invisible**: a slow write
  delays its successors' *wire* departure, but the overlay rendered them instantly
  (never-revert). If it ever matters, batch at the consumer's endpoint (one
  request folding N ops in order) — do NOT weaken the lane.
- **The drain's `await` loop is gone; its early-stop is not.** The failed batch is
  enqueued synchronously in overlay order (an await-loop would let a write
  dispatched mid-drain slot between two older ops it depends on); a `network`
  outcome makes the remaining slots skip, keeping their `failure` so the next
  reconnect edge re-drains from the top.

Motivating incident (page editor): a `split` reaching the server before the
`convertTo` it depended on, so the user's bullet silently reverted one push later
— latent until the caret authority started replaying keystrokes with no pauses.

## Three signals, not one

The pending list answers three different questions; conflating them pins the
sync-status cloud on "Saving…" forever:

| question | signal |
|---|---|
| Has the server acked my write? | `saving` — is any op still **unresolved**? |
| Can I stop predicting this op? | *confirmation* — drop it from the overlay |
| Does the server durably disagree? | *divergence* — a report, not a UI state |

`pendingOps` is the **replay set**: it still contains server-acked ops whose
confirming push hasn't been matched yet, and failed ops awaiting a retry. It is
NOT "is anything unsaved" — read `saving` for that.

## API

The read is a declaration, positionally — mirroring `useLive`'s arguments:

```ts
const picks = useOptimisticResource(prototypePicks, { name }, options); // a param'd liveValue
const unread = useOptimisticResource(someValue, options);              // a param-less liveValue
const ranks = useOptimisticResource(queueRanks, { ids }, options);     // a collection's id set (`:rows`)
if (picks.status === "loading") return <Loading />;
if (picks.status === "error")            // a first load that failed: no base yet
  return <ResourceErrorInline error={picks.error} refetch={picks.refetch} />;
picks.dispatch(change);                  // the ready arm: data, serverData, error, dispatch,
                                         // pendingOps, saving, failed, retry

// options:
{
  apply,               // (current: Data, vars: Vars) => Data — PURE predicted next state
  mutate,              // (vars: Vars) => Promise<void | { watermark?: string }> — the network call
  // Content-based confirmation is an all-or-nothing PAIR (omit both for coarse):
  isConfirmedBy,       // (serverData, vars) => boolean — content-based confirmation
  sameTarget,          // (a, b) => boolean — op identity; REQUIRED with isConfirmedBy (the ordering rule)
  onError,             // optional (err, vars) => void
  label,               // optional string — names the thing being saved (sync-status error state)
  describeOp,          // optional (vars) => string — bounded op summary for the divergence report
}
```

- **`loading` (or `error`) until a base exists, and no placeholder is ever the
  base.** The result is named by `status` like every live read, so it feeds the
  live-state gates and lint rules as one. The base is the first authoritative
  value — or, once one has landed, the last one under a transient error (the
  loud exemption below: the result stays `ready` and carries that failure as the
  ready arm's `error`). `dispatch` exists only on the `ready` arm (a tsc error on
  the others), so an op can never be folded
  onto a base nobody has seen — `prototypes.picks` used to fold a click onto
  `{}` before the stored picks loaded. No live descriptor carries a
  placeholder any more, so no query holds a stand-in value to take.
- **Ops do not reset when the params change** (a re-baseline: the queue's live
  id set moves). The overlay keeps its ops and replays them on the new tuple's
  base; the result is `loading` again until that base lands. A caller that must
  let the user keep acting through that window keeps the `ready` arm it
  rendered from (the queue keeps its last display together with its
  `dispatch`); a caller whose params name a different entity keys the
  component by it, so the overlay starts fresh (the prototype canvas).
- **There is no object form.** The old `useOptimisticResource({ resource,
  params, ...options })` over a `ResourceDescriptor & { initialData }` (the
  placeholder was the base until the first push, and `dispatch` always existed)
  is gone; its last caller, the page editor's blocks, reads `pageBlocks`
  positionally. The read is always a declaration, so nothing can hand the
  overlay a stand-in base.
- **Every optimistic reader asks for acks** on its tuple (`useResourceAcks` —
  see *Exact-ack confirmation* below): nothing to declare, nothing to forget.

- `dispatch(vars)` mints an `opId`, appends `{opId, vars, resolved:false,
  dispatchGen, misses:0, divergenceReported:false, dispatchedAt, attempts:0}`
  to the ordered pending list, and fires `mutate(vars)` (on the send lane).
  `dispatchGen` is the cache generation (`dataUpdateCount`) at dispatch —
  tokenless coarse confirmation compares against it. On resolve the op is marked `resolved`, stamped with the endpoint's
  `ackWatermark` (when returned), cleared of any prior failure, **and immediately
  re-checked for confirmation**. On reject it **stays in the overlay**
  (never-revert) with a classified `failure` — unless the server PERMANENTLY
  rejected it, when it leaves at once and is reported; see the failure model
  below.
- **Ack watermarks (Rule A) and snapshot watermarks (Rule B).** A mutation
  endpoint may return `{ watermark }` — `currentTxId(tx)` (`database/server`)
  read *inside its write transaction* (free; the write already assigned the xid).
  Which live-state frames carry a snapshot watermark (Rule B′), and why
  comparison must go through `compareTxWatermark`, are owned by
  `live-state/CLAUDE.md` ("Commit watermarks"). The one sound inference here:
  `cmp(snapshotWm, ackWm) > 0` (strict) ⇒ that snapshot provably saw the op's
  commit (or its overwrite). Equal or older proves nothing — the snapshot may
  predate the commit no matter how many pushes delivered it; delivery order is
  not causality.
- `failed` is the list of `{opId, vars}` whose `mutate` the server failed with a
  **transient** HTTP status (`classifyRejection`). Network-level failures are
  deliberately NOT in it (they auto-retry), and neither are permanent rejections
  (they have left the overlay) — see the failure model.
  `retry(opId)` re-fires the op **in place**: same opId, same overlay position,
  so the rendered prediction never moves or flickers (it clears the failure and
  re-runs `mutate`; there is no remove + re-dispatch). Consequence: a retried op
  sits **earlier** in the pending order than ops that committed before it, so
  overlay position is NOT commit order. Nothing may infer "older in the list ⇒
  committed first" — the ordering rule doesn't; it only makes the retried op
  block its same-target juniors until it settles, which is correct either way.
- `serverData` is the raw authoritative overlay base — server truth with NO
  pending ops applied (there is none before the first value: the result is
  `loading` instead). For consumers that must distinguish "the server has
  really absorbed this row" from the prediction — e.g. the page editor gates a
  block's content-doc seed (an FK-dependent write) on the block id appearing
  here, never in overlaid `data`.
- **Forced sync-status reporting:** the hook calls `useReportSync` internally
  (`@plugins/primitives/plugins/sync-status/web`) with
  `phase = failed.length ? "error" : saving ? "syncing" : "idle"`, the `label`, a
  `retry` that re-runs **only this hook's own** failed ops, and an explicit
  `savedAt` timestamp. A network-failed op is unresolved, so it reports as
  `syncing` (offline-is-syncing — the Yjs lane's policy), never `error`; only a
  transient HTTP failure is an `error` (a permanent one is a toast, not a state). `savedAt` is stamped (`Date.now()`)
  **inside the resolve handler**, from `resolvePass`'s result, the moment no
  unresolved op remains — NOT from an effect watching a derived boolean, which
  React can coalesce away within one render (the hazard `sync-status/CLAUDE.md`
  documents). Outside a `<SyncStatusProvider>` the report is a no-op.
- **Exact-ack confirmation (`ackTx`).** Feed-driven frames carry `ackTx` — the
  source-transaction ids the recompute folded in — and a recompute that changed
  nothing visible (an empty scoped diff, a net-zero window, a point set the
  write missed) sends a standalone `{ kind: "ack" }` frame instead, **to the
  subscribers that asked for it**. The hook asks on its own: it calls
  `useResourceAcks(resource, params)` (live-state), which sets `acks: true` on
  the tuple's `sub` frame — OR-ed across this tab's readers, and across the tabs
  sharing the socket by the server — and flips it with one `op: "sub-acks"`
  frame when the first reader arrives or the last leaves while the sub stays.
  So a reorder whose write lands outside the subscribed id set, or nets to
  zero, still confirms exactly, and a tuple nobody writes optimistically pays
  nothing. (It used to be a server-declared `ackChannel: true` — only the client
  knows it holds such an op, and a forgotten declaration hung confirmation.)
  Frame production + the narrow claim are owned by `resource-runtime/CLAUDE.md`.
  The client notes them into a module-level tx-ack
  registry (`hasResourceTxAck` / `subscribeResourceTxAcks` from `live-state/web`,
  namespaced per `(key, paramsKey)`, 256-entry ring). Consumption here: a registry
  hit on an op's `ackWatermark` proves *that commit's rows were re-read
  post-commit for this tuple* — so it CONFIRMS the op exactly, on all three edges
  (push, resolve, and the ack edge's `ackPass`), and can NEVER deny; denial stays
  snapshot-watermark-only
  (Rule B). This keeps confirmation exact once scoped/point deltas stop shipping
  snapshot watermarks; a lost ack degrades safely to the Rule B backstop on the
  next full frame / resub. See
  `research/2026-07-18-global-bounded-working-set-phase2.md` Part C (C4).
- **Confirmation runs on TWO edges**, because the confirming push routinely
  arrives *before* the mutation's own HTTP response:
  - **The push edge** (`confirmPass`) — the QueryCache subscription on
    `queryKeyFor(key, params)`. Resolved ops are dropped: content-based when
    `isConfirmedBy(serverData, vars)` accepts the snapshot; coarse-with-token
    when the snapshot watermark is strictly past the op's `ackWatermark` (exact
    causal confirmation); tokenless coarse on any post-resolve push (legacy).
    The registry watermark is read synchronously inside the cache callback — it
    was written immediately before the `setQueryData` that fired it, so it is the
    causal floor of exactly the snapshot being examined.
  - **The resolve edge** (`resolvePass`) — `mutate` came back 2xx: mark the op
    resolved, stamp its ack token, then confirm it *immediately* against what the
    cache already holds. Content-based re-runs `isConfirmedBy`; coarse-with-token
    asks the registry watermark; tokenless coarse asks `gen > op.dispatchGen`.

  Without the resolve edge, an op that resolves one millisecond *after* its
  confirming push is stranded in the overlay **forever** (`confirmPass` saw it
  unresolved and kept it; no further push for that key is coming) — and that
  ordering is structurally biased, not a coin flip: the L4 DB change-feed pushes
  at transaction commit while the HTTP response still has the handler's
  post-commit tail (re-SELECT, parse, serialize) to write. A stranded op keeps
  `saving` true forever and stays in the replay fold, ready to resurrect a row
  another writer later deletes.

  **Only an authoritative snapshot may confirm.** Both edges are gated on one, and
  neither "the cache holds something" nor "the cache emitted an event"
  qualifies (a params re-baseline can resolve an op before the new tuple's
  base lands):
  - The QueryCache emits `"updated"` for **every** query action (`fetch`,
    `error`, `invalidate`, `setState`), none of which touch `state.data`. Only
    `success` bumps `dataUpdateCount`, so the push edge ignores any event that
    doesn't increase it — ungated, a bare `invalidateQueries` would coarse-confirm
    every resolved op and charge each a divergence miss for a snapshot that never
    arrived.
  - Before the first push (`dataUpdatedAt === 0`) the resolve edge passes
    `undefined`, never a stand-in base, because `isConfirmedBy` would accept an
    empty one (an empty base vacuously "reflects" a remove, and
    `isPatchReflected` treats an update naming a missing row as absorbed),
    dropping the op against data never sent.

  **Tokenless-coarse soundness.** `gen > dispatchGen` proves *a* push landed
  after dispatch, not that it carries our commit. In the rare bad ordering (a
  push generated pre-commit, delivered post-dispatch) the op drops early and the
  UI briefly reverts until the real push lands — which is *guaranteed*, since the
  write committed. Bounded and self-healing, never a permanent zombie; returning
  `{ watermark }` from `mutate` removes even that window.
- **Failure model.** A rejected `mutate` is classified once, and only a
  PERMANENT rejection leaves the overlay:
  - **`rejected`** (`EndpointError` whose status `classifyRejection` calls
    `permanent`: any 4xx but 401 / 408 / 429): a FINAL verdict — the server will
    answer the same way however often the op is re-sent. Never-revert protects
    predictions whose outcome is UNKNOWN; this outcome is known, so keeping the
    op would show a state the server has refused to hold, park its same-target
    juniors forever (a collapse that "does nothing"), and lose the edit silently
    on reload. So `rejectOp` removes it at once — a direct removal, not a
    reconcile verdict, since nothing on the server was folded on top of it — and
    the hook emits `optimisticRejectionSink` (`web/reporter.ts`; drained by
    `reports/optimistic-rejection` into an error toast + a report) and calls
    `onError(err, vars, { opId, rejected: true })`, the consumer's cue to unwind
    side state keyed on the op (the page editor drops the undo entry). Newer ops
    are not cascaded: each gets its own verdict on the lane. Design:
    `research/2026-10-08-global-rejected-optimistic-ops.md`.

  Every other rejection keeps the op in the overlay — the prediction stays
  rendered (never-revert):
  - **`network`** (`fetch` rejected — no HTTP verdict: offline, gateway down,
    server restarting): nothing is known to be wrong with the op. It stays
    `syncing` (not in `failed`) and **auto-retries in place, push-based** on
    either reconnect edge — the live-state socket for this resource's origin
    reopening (`subscribeWsStatus` + `liveStateSocketKind`), or the browser's
    `online` event. No timers, no per-push retry; the residue (fetch fails while
    the WS never cycled and the browser never went offline) waits for the next
    edge or a manual `retry`, same as the Yjs lane.
  - **`http`** (`EndpointError` with a TRANSIENT status — 5xx, 401, 408, 429:
    the server failed, not the op). The op surfaces in `failed`, phase `error`,
    and waits for an explicit `retry` — reconnect edges deliberately do NOT
    re-fire it. `onError` fires on every rejection.

  A failed op is **unresolved**, and unresolved ops are untouchable by
  confirmation, denial, and miss counting alike — it just keeps replaying, which
  is exactly the never-revert guarantee.

  **It also parks its juniors.** Unresolved means it survives every pass, so the
  ordering rule holds every newer same-target op in the overlay behind it: a
  `network` failure until a reconnect edge auto-retries it, an `http` failure
  until the user clicks Retry. That is intended — the fold stays intact, so the
  juniors keep rendering correctly and accrue no misses, and the surface is
  already in `error` for the failed op anyway. It is still a behaviour change
  worth knowing: before the ordering rule those juniors could confirm and leave
  ahead of a write that had not landed.
- **Divergence: denial vs report-only.** There is deliberately no miss-limit
  eviction: under push lag its "misses" are stale snapshots computed before the
  commit, so dropping the op reverts the user's edit. What exists instead:
  - **Causal denial** (content mode only — the ONE eviction there is): a
    resolved, unconfirmed, unblocked op carrying an `ackWatermark` is
    dropped when the snapshot watermark is *strictly* past it yet
    `isConfirmedBy` still rejects the snapshot — the snapshot provably saw the
    commit, so the effect was overwritten by newer server truth. Rendering that
    is showing newer truth, not reverting. Reported via the sink with
    `kind: "superseded"`. Coarse mode never denies (no `isConfirmedBy` to attest
    "the snapshot lacks my effect" — a causally-later snapshot can only
    confirm); tokenless ops are never denied (no causal proof exists).
  - **The stalled report** (`DIVERGENCE_REPORT_MISSES = 3`): a resolved op that
    survives that many consecutive authoritative snapshots files ONE report
    (`kind: "stalled"`, latched via `divergenceReported`) and **stays in the
    overlay**, still confirmable by any later matching snapshot. It is the
    investigation signal for a wrong `apply`/`isConfirmedBy` pair — or plain
    push lag, which self-heals. A **blocked** op counts no miss: a miss means
    "a fresh snapshot arrived and still didn't reflect the op", and a pass we
    declined to evaluate is information-free — counting it would file a
    `stalled` report about a verdict never formed. The front of each same-target
    chain is never blocked, so the signal survives. The resolve edge counts no
    miss and never denies — no new snapshot arrived, so a non-confirmation
    carries no evidence.
  - **Self-supersession files no report.** A denial whose op has a newer
    same-target op confirmed in the *same* pass is the client overwriting its
    own write (undo→redo), not a lost race: the drop still happens, the
    `superseded` report is suppressed. Misclassification costs a mis-filed
    report and never a lost edit, which is where a heuristic belongs.
- **`optimisticDivergenceReportSink`** (`web/reporter.ts`) is the sanctioned sink
  inversion, mirroring `error-boundary`'s `boundaryReportSink`: this primitive
  must not import `reports`, so `reports/plugins/optimistic-divergence` registers
  the handler at mount and files the report. The payload
  (`{ kind, resourceKey, params, label, misses, opSummaries }`) carries no raw
  `vars` — unbounded and possibly unserializable; `opSummaries` comes from the
  optional `describeOp(vars)` arg (empty if omitted), which must be pure and
  total — it runs on the reconcile path. `emit` never throws.
- **The ordering rule** (content-based mode — this plugin owns it; `page/editor`
  defers here): `sameTarget` is **required** alongside `isConfirmedBy` — the two
  are a paired, all-or-nothing arm of a discriminated union, and each half alone
  is unrepresentable (pinned at type level by `web/internal/args-types.test.ts`).
  The rule:

  > An op may not **leave** the overlay while an older, still-pending,
  > same-target op survives this pass.

  It applies **only in content mode**: `decideVerdicts` blocks nothing without a
  `sameTarget`, so coarse consumers get no ordering rule. Correct, not an
  oversight — with no identity relation you cannot know which ops interact, and
  coarse mode's exits are confirmation-only (it never denies).

  Why it must exist: the rendered value is `pendingOps.reduce(apply, serverTruth)`,
  an ordered fold. Removing a *middle* element changes the composition — drop B
  while A remains and the user sees `A(base)` instead of `B(A(base))`, a state
  they never created. This holds even with perfect evidence about B, so no
  amount of proof licenses an out-of-turn departure. (The predecessor rule,
  same-target *cascade*, did the opposite — a confirmed newer op evicted older
  same-target ops — and shipped an incident where a live block vanished for ~90s:
  `research/2026-09-01-global-overlay-ordered-fold-no-transitive-eviction.md`.)

  - **Gates every exit route** — content confirmation, exact `hasAck`, coarse,
    and denial. Gating only content leaves the hole open through the ack door: A
    deletes X, B recreates it, the net recompute changes no value, so a
    standalone `{kind:"ack"}` frame confirms B *exactly* while the cached pre-A
    snapshot still shows X; drop B, replay A, X vanishes.
  - **A denied older op does not block** — the snapshot provably lacks its
    effect, so the base is past it, not stale with respect to it. A just-confirmed
    older op doesn't block either: it is leaving in this same pass.
  - **Evicts nothing.** A wrong answer costs a deferred confirmation, never a
    reverted edit — which is also why `sameTarget` may stay an intersection test:
    over-matching only defers.
  - **Liveness.** Blocking runs strictly older→newer over array order, so the
    waits-for graph is a total order restricted to same-target pairs — a DAG, no
    cycle spellable. The oldest op on a target is never blocked, so it is decided
    exactly as before; when it leaves, its successor becomes the front. Every
    chain drains from the front.
  - **Coverage is exactly as good as `sameTarget` is accurate.** An
    under-approximating relation means less *blocking*, so two ops that really do
    interact in the fold may not register as same-target and one can leave early.
    That statement holds for any consumer, and the fix is the consumer's: make
    `sameTarget` name the rows an op really writes. The page editor did so on
    2026-09-02 — its relation is now the union of what the reducer measurably
    wrote (a before/after diff over the op's own predicted output) and what the
    op names, so a merge's unnamed target row and a split's adopted children are
    covered. What remains there is that the measurement is taken at dispatch,
    not at replay: a different base at replay can make the real write set a
    strict superset. `overlayOpTargets`' doc comment in
    `page/editor/web/internal/optimistic-block-ops.ts` is the detailed
    statement; the design is
    `research/2026-09-02-page-overlay-ops-declare-rows-they-write.md`.

  It closes the stuck-inverse-pair hazard the cascade existed for (undo "delete
  X", redo "restore X" dispatched before the deletion's push: every later
  snapshot shows X present, confirming the redo and never the undo) by making the
  redo *wait* instead of evicting the undo. Both replay, X renders present, and
  the pair drains as soon as any watermark-carrying frame denies the undo.
  Content-mode consumer: the page editor (`sameOverlayTarget` — block-id-set
  intersection over ops/patches, `web/block-store.ts`). The conversation queue
  (`queueRanks` `{ ids }`) and the prototype canvas (`prototypePicks`) are the
  coarse-mode consumers and supply neither half.
- `apply` must be pure. For the "this op no longer applies to the current base"
  case (e.g. the server already absorbed it and the row it referenced is gone),
  throw `OpNoLongerApplies` (exported from the barrel) — the replay drops just
  that op and keeps the rest. Any OTHER throw is treated as a reducer bug and
  propagates loudly (fail loudly — never silence), rather than vanishing into a
  self-healing push.
- Op insertion order is preserved, so fast chained ops compose deterministically.

## Two rejected fixes, so they aren't re-proposed

- **A causal floor on content confirmation** (reject a confirmation when
  `W < op.ackWatermark`). Not unsound — but it **wedges under the exact load it
  exists to survive**. `xmin` is the lowest still-running xid, so one long
  transaction pins it low cluster-wide, and `SOURCE_TX_CAP = 64` makes the
  runtime suppress the *entire* `sourceTx` set on overflow — killing `hasAck`
  too. Both confirmation routes die at once, the overlay grows at the user's
  edit rate for the whole episode, and replay goes quadratic. It also
  contradicts `live-state/CLAUDE.md` ("an absent watermark means *no causal
  floor*: confirming by content is fine, denial is forbidden").
- **Absorbing through the ack door** instead of blocking (when B is
  ack-confirmed and orders after A, drop A with it). Deferred, not unsound in
  principle — but it needs a **subset** relation, not `sameTarget`'s
  intersection, or it discards A's effect on rows B never wrote. The fail-closed
  `coversOverlayTarget` sketch (only a patch may be absorbed) is in the research
  doc. It only shortens a wait the rule already renders correctly through, so
  revisit it only if deferral measurably fails.

  The objection to absorbing a structural op has **changed shape, not gone
  away**. It used to be that such an op's target set is an under-approximation
  *by construction*. Now the page editor measures the rows its ops write, so the
  set is exact — but only against the base the op was predicted on, which need
  not be the base it replays against. A symmetric intersection stays sound
  either way, because an over-match only defers a departure; a subset test does
  not. So the sketch's `older.tag !== "patch"` guard stays.

  And the guard's own reason — "only a patch's target set is exact" — is a
  **provenance** argument rather than a shape one, which is worth recording
  before someone reads it as the latter. `applyPatch` and the server writer both
  cascade `deleteIds` to descendants, while the target set names only the ids
  the patch itself lists. The claim holds today only because every patch in the
  wild comes from `patchesFromDiff(diffBlocks(before, after))`, whose
  `deletedIds` is already the post-cascade set. A hand-built patch deleting a
  subtree root would break it.

## Where the logic lives

The **whole op lifecycle** is a pure state machine in `web/internal/overlay.ts`.
Deciding and partitioning are split, because the blocking test needs each op's
**final** fate — denial included — before any newer op consults it:

- `decideVerdicts` — one forward loop, oldest first, assigning each op
  `confirmed | denied | denied-silent | unconfirmed | pending | blocked`. The
  first three drop; the last three keep, and only `unconfirmed` costs a miss.
  `pending` is an unresolved op (in flight, or `mutate` rejected) — nothing is
  known to be wrong with it, so it keeps AND **blocks**: it is a survivor of the
  pass. Because the loop runs oldest-first, an op's fate is fixed before its
  juniors read it.
- `reconcile` — a pure partition of that verdict array plus the miss/latch
  bookkeeping. It holds no `sameTarget` and no watermark; all the deciding is in
  the loop above.

`ReconcileResult`'s `dropped` *is* the report channel; `confirmed` is the
timing channel — each confirmed op with the `ConfirmMode` that proved it (the
`confirmed` verdict carries it), read only by the confirm latency sample (below).
A `denied-silent` op is in no list. Around them sit `replay`, the three edges
`confirmPass` / `resolvePass` / `ackPass`, and `markSent` / `markResolved` /
`markFailed` / `clearFailure`. Every edge returns the input `pending` array **by
identity** when nothing changed, so the React shell skips the state write. Unit-tested in `overlay.test.ts` (`bun test`) — where new
lifecycle coverage belongs.

The hook (`web/internal/use-optimistic-resource.ts`) is a thin shell —
`resolveForm` turns any of the read forms into (descriptor, params, options)
with no hooks, so every form runs the same one core hook: the `pending` state
(mirrored in a commit-time ref, because a functional `setState`
updater cannot yield the report lists without becoming effectful), the cache
subscription, the reconnect auto-retry subscription, the `savedAt` stamp, and the
sink emits. Its wiring — `dataUpdateCount` stamp, push-before-resolve ordering,
keep-rendered failures, `online` auto-retry, registry-watermark denial, send-lane
ordering, one confirm latency sample per edge — is pinned by `web/__tests__/use-optimistic-resource.test.tsx`
(`./singularity test plugins/primitives/plugins/optimistic-mutation`).

## Confirm latency (the `confirm` client latency signal)

How long an optimistic write takes to be **confirmed** — dispatch → the edge
that drops it from the overlay — is emitted on `clientLatencySink`
(`perfs/latency-signal`; consumers: slow-ops, latency-ledger). Design:
`research/2026-10-13-global-live-latency-in-slow-ops.md`.

- **Stamps live on the op** (`PendingOp`), all `performance.now()` — the
  client's own monotonic clock, so no phase carries clock skew:
  `dispatchedAt` (overlay append), `firstSentAt` / `lastSentAt` / `attempts`
  (`markSent`, called at the top of `runMutate` — past the send lane, so it is
  the real wire departure, and every retry re-enters there), `ackedAt`
  (`markResolved`, the latest 2xx). No verdict reads them.
- **Phases**: `send-lane` = firstSent − dispatched (the head-of-line wait),
  `retry` = lastSent − firstSent, `server-ack` = acked − lastSent,
  `confirm-frame` = confirmed − acked (clamped ≥ 0 by `splitPhases`).
  `totalMs` = confirmed − dispatched. A confirmed op is always resolved, hence
  sent: a missing stamp throws (`confirmSample`).
- **Variant** `<mode>/<edge>`. Mode (`ConfirmMode`): `exact-ack`, `watermark`
  (coarse, snapshot past the token), `content`, `tokenless` — the last is not
  causal, so its numbers are no proof the push carried the commit. Edge:
  `push` (the confirming snapshot landed after the response), `resolve` (it beat
  the response — `confirm-frame` is 0), `ack` (a standalone ack frame; the ack
  edge calls `reportOutcomes(next, "ack")` like the other two).
- **Hidden**: tagged when the tab is hidden now or changed visibility at any
  point since dispatch (`web/internal/tab-hidden.ts` — one side of every
  visibility change is hidden); consumers exclude it.
- **Nothing is emitted** for an op that never confirms (denied, denied-silent,
  rejected, stalled, unmounted while pending) — rejections and stalls already
  have their own sinks — nor, wholesale, when the sink has no subscriber.
- **Write paths NOT covered** (no overlay op to time): a detached
  `enqueueResourceWrite` / `enqueueDetachedWrite`, `useEndpointMutation`
  invalidates, config_v2 writes, Yjs collab text, `editable-field`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Optimistic-mutation primitive over live-state: useOptimisticResource replays pending ops on server truth (overlay/replay) under the never-revert policy — causal (ack-watermark) and content-based confirmation, denial only under causal proof, keep-rendered transient failures with reconnect auto-retry, and permanent (4xx) rejections dropped and reported.
- Web:
  - Uses:
    - `infra/endpoints.EndpointError`
    - `infra/endpoints.getEndpointErrorMessage`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/live-state.queryKeyFor`
    - `primitives/live-state.useLiveRegistries`
    - `primitives/live-state.useLiveSocketKindOf`
    - `primitives/live-state.useResource`
    - `primitives/live-state.useResourceAcks`
    - `primitives/networking.subscribeWsStatus`
    - `primitives/sync-status.useReportSync`
  - Exports (types):
    - `OptimisticDivergenceReport`
    - `OptimisticOptions`
    - `OptimisticRejectionReport`
    - `OptimisticResult`
    - `OptimisticSettled`
  - Exports (values):
    - `enqueueDetachedWrite`
    - `enqueueResourceWrite`
    - `OpNoLongerApplies`
    - `optimisticDivergenceReportSink`
    - `optimisticRejectionSink`
    - `useOptimisticResource`
- Cross-plugin:
  - Imported by:
    - `apps/prototypes/canvas`
    - `apps/sonata/track-mixer`
    - `conversations/conversations-view/data-view/queue`
    - `conversations/conversations-view/queue`
    - `page/editor`
    - `page/tags`
    - `reports/optimistic-divergence`
    - `reports/optimistic-rejection`
- Exemptions:
  - Exempts itself from: `live/no-legacy-resource-spelling` — `.` (sanctioned)

<!-- AUTOGENERATED:END -->
