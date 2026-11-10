# Issue: git-derived loaders — `edited-files` / `commits-graph`

**Status: ONGOING** — the dominant remaining real cost once the
[no-op churn](./issue-live-state-noop-churn.md) was fixed. This is the *original* cause (A) from the
2026-06-28 assessment, de-prioritized while the big-blob churn masked it, now unmasked.

## Current understanding (2026-06-29, session 6 decomposition on `singularity`)

The still-firing slow ops are `element`-kind `edited-files` / `commits-graph.delta` at ~1.3–1.5 s
(distinct from the now-fixed churn — this is *legitimate but expensive git work*, not illegitimate
high-rate work). Work-vs-wait split from the live loader profile:

| Loader | avg | workMs | dominant wait | verdict |
|---|---|---|---|---|
| `edited-files` | 576 ms | **569** | none (memo hit ~30 ms typical) | **work-bound** — misses do ~1.3–1.5 s of real git work |
| `commits-graph.delta` | 941 ms | 82 | **`heavy-read-local` ~843 ms** | **wait-bound** — a *victim* of the gate |

- **`edited-files` (the driver).** On a memo miss it runs **4 sequential git spawns** —
  `merge-base`, `diff --name-status`, `status --porcelain --untracked=all`, `diff --numstat` — plus
  untracked line-counting, all under `withHeavyReadSlot`
  (`conversation-view/code/server/internal/get-edited-files.ts:90`). On an 18-CPU host the gate is
  only **4 slots host-wide / 2 per worktree** (`floor(cpus/4)`). Typical case is a fast memo hit
  (~30 ms); the ~1.3–1.5 s misses are the `element` slow ops, plus 9–18 s cold misses during the
  cold-boot herd (see [cold-boot fan-out](./issue-cold-boot-fanout.md)).
- **`commits-graph.delta` (the victim).** Its own work is only 82 ms; it spends ~843 ms **waiting on
  the host gate behind `edited-files`** (`commits-graph/server/internal/compute-graph.ts`). Head-of-
  line blocking, not slow itself.

### Open rate-axis suspicion (trace before any cost-axis fix)

Per the [`perfs-investigation`](../../.claude/skills/perfs-investigation/SKILL.md) method, don't jump
to the cost axis ("parallelize/cache the git op") yet. The @parcel watcher
(`watch-edited-files.ts`) recomputes on **every** fs event (debounced 200 ms, ceiling 2000 ms) and
its unchanged-result early-return happens **after** paying the full ~1.3 s git compute (`recompute()`
computes → serializes → *then* compares). So an fs event that doesn't change the diff (mtime touch,
editor temp file, write-then-revert, anything outside the IGNORE globs) still burns a full git
computation and holds a gate slot — **the same no-op shape as the fixed churn, on the fs-watch
axis.** Needs measuring (recompute rate vs. real change rate) to decide the altitude: make the git
cheaper / off the critical path (cost) vs. don't recompute on no-change events (rate / origin).

**Next:** a Phase-2 trace of the watcher recompute rate vs. actual edited-files change rate on an
active worktree.

## Fresh re-validation (2026-07-01) — still live, now tailing to multi-minute flush stalls

Surfaced while answering "a new conversation took a few minutes to appear in the agent-manager
sidebar queue list." Root of that symptom traced here: the live-state **flush** that delivers the
`queue-ranks` / `conversations-active` diffs to the browser was backed up **multiple minutes** behind
the git-loader gate, so the sidebar didn't update until the flush drained. Live `slow_ops` snapshot on
`singularity` (~13:38):

| op | last_ms (happening now) | max_ms (since-boot peak) | last_seen |
|---|---|---|---|
| `flush / flushNotifies` | 4.1 s | **990,770 ms (~16.5 min)** | 13:38:04 |
| `loader / commits-graph.delta` | 14.8 s | 740,347 ms (~12.3 min) | 13:38:00 |
| `loader / edited-files` | 18.3 s | 740,210 ms | 13:29:25 |
| `db / [heavy-read-local]` (per-worktree gate) | 48.1 s | 735,439 ms | 13:27:23 |
| `db / [heavy-read-acquire]` (host gate) | — | 739,354 ms | 2026-06-28 |

Reading per the debug skill (`last_ms` = live, `max_ms` = sticky since-boot peak): the **`last_ms`
column is the steady-state and is already multi-second to ~48 s** — this is not a stale boot peak. The
git-loader gate contention named in session 6 is **still active on `singularity`** and its tail now
reaches ~12 min on the loaders / ~16 min on `flushNotifies`. This is a NEW manifestation beyond
"slow first-subscribe": it delays *any* live-state UI update (here, a sidebar list) by minutes while a
flush is queued. Context: recurring `queue-backlog` report (count 545) and `live-state-noop` (count
5496) on the same DB — a heavily-loaded instance with many open conversations (⇒ many
`edited-files`/`commits-graph` subscriptions).

**RESOLVED (2026-07-01 session 2 Phase-2 trace) — the flush stall is NOT a git-loader problem.**
The open question posed a false dichotomy; the answer is **neither**. Three converging lines
(live coherent-window profile + code + boot-path data) show the git loaders never touch the
flush, and the flush's own multi-minute peak is a boot/catch-up DB-pool artifact — the
[cold-boot fan-out](./issue-cold-boot-fanout.md) root, not this issue. Evidence:

1. **The expensive git work is `sub`-origin, never `push` (flush) origin.** In a coherent window
   (`sinceMs` 18.6 s) `edited-files` runs as `sub` at **avg 10.9 s / max 31.9 s** (three ~31.9 s
   subs at the same `atMs` — a fan-out herd); its `push` (flush-cascade) count is **zero**.
   `commits-graph.delta` push is 45 ms. **Gate 2 (legitimacy):** the flush does not carry the git
   cost.
2. **The flush stays sub-second *while* the 31.9 s git subs run concurrently.** Same window: `flush`
   max **1266 ms** (`atMs` 4887), and at `atMs` 32 000–35 000 — *during* the 31.9 s `edited-files`
   herd — flushes are **6.4 ms / 570 ms**; steady-state `flush.lastMs` **0.037 ms**. A concurrent
   6 ms flush is impossible if the 31.9 s git work were blocking the event loop or queued ahead of
   the flush ⇒ that 31.9 s is almost entirely **async I/O wait** (git subprocess + `heavy-read-local`
   gate), which *yields* the loop. **The flush is not starved by, nor queued behind, the git loaders.**
3. **The git resources are structurally excluded from the flush's boot recompute.** `edited-files` is
   `defineExternalResource` and neither it nor `commits-graph.delta` is `bootCritical`; since
   `shouldPersist = bootCritical && !externalSource`, `drainEntry`'s `persisted` FULL-recompute path
   never runs for them. What *does* run FULL inside the flush at boot is the **bootCritical DB-backed
   set** (`queue-ranks`, `tasks`, `attempts`, `conversations-active`, `conversation-progress`, …):
   `live-state-snapshot`'s `onReady` does `recomputeResource(key)` for each + `runCatchUp()`, both
   routing through `scheduleNotify → flushNotifies → drainEntry(persisted)` (captureWatermark + FULL
   loader + persistSnapshot). Those loaders are gated by the **DB connection pool** (`loader-acquire`),
   whose herd tail is **40–75 s** (`[acquire]` max 75.9 s, per cold-boot-fanout). Serialized by the
   flush's level barriers + single-active-flush mutex, that is what inflates `flushNotifies` to the
   minutes-scale sticky `max_ms` — a **DB-pool** cost, zero git.

**Measurement caveat (honest gap):** the `flush.workMs == avgMs` reported by the profiler is NOT
"CPU work" — the `flush` span records the whole `runFlushCycle` wall-clock, and every gate-wait
inside charges the *nested* `push`/`loader` entry (innermost), never the `flush`. So a big
`flush.max` with empty `waits` is untracked wall-clock (mostly awaiting DB-pool-gated bootCritical
loaders), which the prior 2026-07-01 note mis-read as the flush being "behind the git loaders."

**Fixed (2026-07-02):** the profiler now propagates gate waits to every open ancestor entry via
streaming interval-union, so a `flush` reports the gates its subtree waited on directly, and every
span's wall-clock decomposes into `waitMs`/`childMs`/`selfMs` (`workMs` removed). The mis-read
above is structurally impossible now — see
[`research/2026-07-02-global-profiler-wait-propagation.md`](../2026-07-02-global-profiler-wait-propagation.md).

**Reattribution:** the "new conversation took minutes to appear in the sidebar queue" symptom is the
cold-boot / **WS-reconnect fan-out herd** on the DB-pool gate (the `queue-ranks` sub/deliver queued
behind the ~30-resource boot herd on `loader-acquire`) — it belongs to
[`issue-cold-boot-fanout.md`](./issue-cold-boot-fanout.md), not here. This issue (git-derived
loaders) remains real but is scoped to the **`sub`/first-subscribe + fs-watch** path.

**One direct confirmation still worth capturing (does not change the conclusion):** catch a *live*
multi-minute `flush` span and show its nested `push`/`deliver:*` children are DB-backed bootCritical
loaders whose `loader-acquire` waits sum to the minutes, with **zero** `edited-files`/`commits-graph`
push children. The clean window above already shows the shape (max flush 1.3 s = its slowest
`deliver:*` branch under mild pool contention); a boot-herd capture would show the same shape scaled
by the 40–75 s pool tail.

## Causes — checklist

Legend: ✅ confirmed with data · ❌ discarded (with reason) · 🔬 open / needs proof

- ❌ **Git-loader gate tail delays live-state flush delivery** — 2026-07-01 (2), killed by **gate 2
  (legitimacy) + a direct counterfactual**: in a coherent window the flush stays **≤1.3 s (6 ms during
  the herd)** while `edited-files` `sub` loaders run **31.9 s concurrently**, and the git resources are
  `external`/non-`bootCritical` so they never enter the flush's `persisted` FULL-recompute. The flush's
  minutes-scale `max` is the **bootCritical DB set** FULL-recomputing under the **DB-pool** `loader-acquire`
  tail (40–75 s), routed through the flush by `live-state-snapshot.onReady` (`recomputeResource` +
  `runCatchUp`). That is the [cold-boot fan-out](./issue-cold-boot-fanout.md) root, not git. The prior
  reading conflated the flush's untracked wall-clock (it awaits DB-pool-gated bootCritical loaders) with
  "behind the git loaders." Symptom (new conversation slow in sidebar) reattributed to the reconnect herd.
- 🔬 **`edited-files` cold-miss compute is the driver** — 2026-06-29 (6): work-bound, ~1.3–1.5 s of
  real git work per memo miss (4 serial git spawns). Open: is the watcher recompute *rate* legitimate,
  or amplified by no-change fs events (recompute pays full git cost *before* the unchanged-result
  early-return)? Phase-2 trace pending.
  - 2026-06-29 (conversation-load 40 s session) **`benchmark_boot` confirms `edited-files` is ~1.4 s
    even WARM** (cold 1.41 s, warm 1.34 s; `commits-graph.delta` 0.70/0.62 s) — the memo barely helps
    on this fixture, so the 4 serial git spawns are the real per-conversation steady-state floor. But
    1.4 s ≠ the 40 s symptom: that floor is **legitimate cost**, and the 40 s is the
    [fan-out herd](./issue-cold-boot-fanout.md) (loaders are victims of the per-backend DB-pool gate,
    not the host git gate). Parallelizing the 4 spawns is a *containment* win on the floor, independent
    of the herd cure. See [`2026-06-29-conversation-load-40s-fanout-herd.md`](./archive/2026-06-29-conversation-load-40s-fanout-herd.md).
- 🔬 **Per-worktree local heavy-read gate (size 2 = `ceil(host/2)`)** = 21,858 ms (session 2) and now
  the live wait for `commits-graph.delta` (workMs 82 vs ~843 ms `heavy-read-local`). Real, and no
  longer 2nd-order now that the big-blob churn is bounded — the gate behind which the git loaders
  queue. Revisit alongside the driver above.
- ❌ **Git loaders' work is slow (as a flat claim)** — 2026-06-29: `edited-files` work = 16 ms
  (prod, **memo-warm**), `commits-graph.delta` work ≈ 31 ms. *Nuanced by session 6: the memo-warm hit
  is ~30 ms, but a memo **miss** does the full ~1.3–1.5 s git compute — so the cost is real on the
  miss path, not the hit path.*
- ❌ **Host-wide heavy-read gate (`withHeavyReadSlot`, host size 4) is the contention** — 2026-06-29:
  `heavy-read-acquire` (the *host-wide* flock wait) = **17 ms total** across all loaders. Negligible.
  *The original git-off-critical-path plan targeted only this — hence "wrong path". The contention
  that does bite is the **per-worktree** `heavy-read-local` tier above, not this host-wide one.*

## Sessions

- **2026-06-28 — [boot & git-loader slowness assessment](./archive/2026-06-28-boot-and-git-loader-slowness-assessment.md).**
  Named cause (A): git-derived loaders (`edited-files`, `commits-graph`) on the first-subscribe
  critical path under the host heavy-read gate. Flagged as a primary suspect. *Superseded as the
  *primary* driver by the 2026-06-29 sessions (the churn dominated), but the underlying git cost was
  never disproven — only out-prioritized.*

- **2026-06-29 — [DB-pool exhaustion vs git loaders (root-cause hunt)](./archive/2026-06-29-db-pool-exhaustion-flush-cascade-findings.md).**
  Measured the git loaders directly: **16–315 ms in isolation, 172–448 ms under a fully-saturated
  host heavy-read gate** — not the 7 s symptom. Concluded they were *victims* of DB-pool exhaustion,
  and the `heavy-read-acquire` gate wait was then only 17 ms total. *Re-opened by session 6: with the
  churn (and thus the pool exhaustion) gone, the git loaders' own work — and the per-worktree
  `heavy-read-local` gate wait — are now the top remaining cost. Session 2's checklist had parked
  this as "🔬 per-worktree heavy-read gate = 21,858 ms — real but 2nd-order; revisit after the
  big-blob resources are bounded."*

- **2026-06-29 (6) — decomposition (recorded above).** Re-measured on `singularity` after the churn
  fix: `edited-files` work-bound ~1.3–1.5 s/miss; `commits-graph.delta` wait-bound on the 4-slot
  gate; opened the watcher no-change-recompute rate-axis question. Surfaced while answering "we're
  still detecting slow ops — is it another issue?" (yes — this one). No code changes; Phase-2 trace
  pending.

- **2026-07-01 — fresh re-validation (recorded above).** Live `slow_ops` on `singularity` show the
  gate contention is still active, tailing to ~12 min on the loaders and ~16 min on `flushNotifies`,
  and now manifesting as **multi-minute latency for a live-state UI update** (a new conversation not
  appearing in the sidebar queue for minutes). Surfaced while debugging that symptom. No code changes;
  Phase-2 trace (flush-cascade-contains-loaders vs flush-queued-behind-loaders) filed as a task.

- **2026-07-01 (2) — Phase-2 flush trace (recorded above; the open question is RESOLVED).**
  Read the flush code path (`resource-runtime/core/runtime.ts` `flushNotifies` → `runFlushCycle` →
  `drainEntry`), the profiler recorder semantics (`flush.workMs` = full wall-clock, gate-waits charge
  the nested `push`/`loader`, not the `flush`), and a coherent live `get_runtime_profile` window.
  **Result: the "flush queued behind git loaders" framing is refuted (gate 2 + counterfactual).** The
  git loaders are `sub`-origin only and never enter the flush (they are `external`/non-`bootCritical`);
  the flush stays ≤1.3 s while 31.9 s git subs run concurrently ⇒ not starved by them. The flush's
  minutes-scale peak is the bootCritical DB set FULL-recomputing under the **DB-pool** `loader-acquire`
  tail at boot/catch-up (`live-state-snapshot.onReady` → `recomputeResource` + `runCatchUp`), i.e. the
  **cold-boot fan-out** root. Symptom reattributed to the WS-reconnect herd. No code changes; a direct
  boot-herd flush capture remains the one nice-to-have confirmation. This issue is now scoped to the
  `sub`/first-subscribe + fs-watch axis; the flush/delivery-latency angle moves to
  [`issue-cold-boot-fanout.md`](./issue-cold-boot-fanout.md).
