# A slow flush pass is filed once, not by every delivery queued behind it

Task: task-1793374863 ("Deliveries in one flush each file ~1.8 s own slow-ops for
one cause"), a regression of task-1793316427-xlxoqr
(`2026-10-30-global-slow-op-one-cause-one-report.md`), on top of
`2026-10-30-global-slow-op-own-time.md`.

## What happened (main, 2026-10-30 15:36:07Z)

Main restarted at 15:36:02.6 (ready 04.3) and every open tab resubscribed:
~100 `sub`s queued on the 6-slot `read-admit` gate for ~1.1–1.8 s each, with
`background-acquire` at 7 active / 25 queued.

From the trace of `deliver:jsonl-events` (1fb1c8f8…, times relative):

- **Flush pass N**, 2388 → 4506 ms (2118 ms), had ONE push:
  `config-orphans.report`, which JOINED (`read-coalesce` 2115 ms) a tab's
  `sub` read of the same key, itself queued 807 ms on `read-admit` and then a
  1323 ms loader. Nothing in it crossed its bar: the pass's own time is ~3 ms
  (the join is excluded), the loader 1.3 s < 2 s, the gate wait 0.8 s < 2 s.
- Everything else became stale DURING pass N (`deliver:jsonl-events` enqueued at
  2687, `sentinel.status` at 3036, …). The flush lane is serial (`flushState`
  `running` → `rerun`), so they waited for pass N to end.
- **Pass N+1**, from 4506, drained them all in ~25 ms and sent at 4513–4531.

So every delivery's window was ~1.8 s of queue for pass N plus ~25 ms of its
own drain. A delivery is a latency leaf, judged at `updateMs` (1000) net of
"the claims its enclosing entry collected inside its window" — but its
enclosing entry is pass N+1; pass N (closed) and its claims are invisible to
it. Nothing was filed for pass N, so there was nothing to subtract either way.
Fifteen deliveries → fifteen fingerprints. (`claude-code-status` 2139 ms and the
`live_state_snapshot` INSERTs are the same boot herd, filed on their own bars —
not this bug.)

## The rule

A delivery's window is three parts, each with one owner:

```
first notify ──hold──▶ released ──queue──▶ drain starts ──own──▶ sent
             declared             the flush lane         this resource
```

- **hold** — the entry's declared throttle (already excluded, `throttle-hold`).
- **queue** — waiting for the flush LANE: an earlier pass still running, or an
  earlier depth level of this pass. Not the resource's time. The lane's.
- **own** — its own load and send: what `deliver:<key>` is judged on.

The queue is the lane's slowness and is filed the way a gate's queue is — one
`wait flush-queue` fingerprint, each queued delivery a caller — at the
UPDATE bar (it is user-visible staleness), **net of every op already filed
inside the lane during the wait**. So:

- a slow delivery at the head of the line (`deliver:config-orphans.report`,
  2131 ms of its own drain) is the one report, and everything queued behind
  it is net of it — nothing more is filed;
- a pass slow for no filed reason (all its parts under their bars) is filed
  once, as `wait flush-queue` (count = deliveries that waited, all in
  `slow_op_callers`, the trace's completed `flush` span naming the pass's
  resources);
- a pass containing a filed loader / filed flush: the queue is net of it, so
  nothing more.

## Pieces

### 1. Runtime: the queue as its own number (`resource-runtime`)

`PendingNotify.queueMs`, stamped by `drainEntry` when it snapshots the pending:
`drainStart − (enqueuedAt + holdMs)`, ≥ 0. `ResourceDelivery.queueMs` carries
it. `latencyMs = holdMs + queueMs + own`. The wire `timing` is unchanged (the
client no longer counts the server's window at all).

### 2. Profiler: lanes, and a leaf's queue (`runtime-profiler/core/recorder.ts`)

- **A root entry kind is a lane.** Every claim that reaches a root entry (the
  ancestor walk of `claimEnclosing`), and a root entry that is itself filed, is
  also kept in a bounded per-root-kind ring (`laneClaims`, positioned, cap 32,
  drop-oldest). It outlives the entry, so a later run of the lane can see what
  an earlier one claimed.
- `LeafSpanOptions.queue: { layer, ms }` — the part of a latency leaf's window
  right after its `waits`, spent queued for its enclosing root's lane. The leaf
  excludes it in full. Its remainder — net of the lane's claims inside
  `[queue start, drain start]` — is handed to `onSlowWait` as a queue wait
  (`latency: true`, caller = the leaf itself), so it is filed against the lane,
  once per fingerprint.
- A latency leaf's own claims are intersected with its drain part only
  (`[end − own, end]`), never with the hold or the queue, so no interval is
  subtracted twice.

### 3. slow-ops: a latency wait is judged on the update bar

`SlowWait.latency` → `resolveWaitThreshold` = `updateMs`, else `loaderMs`; the
`onSlowWait` floor becomes `min(loaderMs, updateMs)`. A `flush-queue` hint in
`WAIT_LAYER_HINTS` says where to look (the trace's completed `flush` span).

### 4. server-core wiring

`onDelivered` passes `queue: { layer: "flush-queue", ms: info.queueMs }`.

## With leaf drain lanes (task-1793374871-6t20yk)

A sibling change (`2026-10-30-framework-live-flush-leaf-drain-lanes.md`) stops a
LEAF's drain (no downstream; `config-orphans.report` here) from holding the
pass, which would have removed this incident's head-of-line. That lowers how
often a delivery queues; it does not change who should be charged when one does.
Queues remain behind drains that have dependents, behind an earlier level of a
pass, and for a leaf behind its own lane still in flight. The two changes
compose:

- `queueMs` is stamped where a drain takes a pending (`drainEntry`), whichever
  pass or lane runs it.
- Lanes keep every drain inside an OPEN `flush` entry (the pass span awaits its
  lanes), so a delivery's root is still a `flush` and its lane's claims are found.
- Passes may overlap in time once lanes land. Then a queue is judged net of the
  claims of every `flush` entry inside its window, not only the one it waited
  on. It can only be judged on less than it was owed, so a report can be
  missed, but never duplicated. That is the same direction the rule already
  errs in.

## Verification

- Runtime: a pending enqueued while a pass runs reports `queueMs` ≈ the rest of
  that pass; a deeper level's cascade target reports the earlier levels; a
  leading-edge pending ≈ 0.
- Recorder: a leaf queued behind a closed earlier root that claimed an op files
  no queue wait; behind an unclaimed one, files `flush-queue` net of nothing,
  `latency: true`, caller = the leaf; the leaf's own time excludes hold + queue
  and only drain-part claims.
- slow-ops: `resolveWaitThreshold`, floor.
- After landing: the next main restart's markers should show at most one row
  per head-of-line cause instead of one per delivery.
