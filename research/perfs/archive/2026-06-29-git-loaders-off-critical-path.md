> **⚠️ SUPERSEDED / DO NOT IMPLEMENT (2026-06-29).** Empirical measurement that same
> day ([db-pool-exhaustion findings](./2026-06-29-db-pool-exhaustion-flush-cascade-findings.md))
> showed the host heavy-read gate this plan targets is **17 ms** total — a non-issue.
> The git loaders are victims of DB-connection-pool exhaustion, not a root cause. Kept
> only as a record of the investigated-and-discarded path. See [CLAUDE.md](./CLAUDE.md).

# Plan: git-derived loaders off the first-subscribe critical path

**Date:** 2026-06-29
**Category:** global (conversations · framework/resource-runtime · debug/boot-bench)
**Predecessor:** `research/perfs/2026-06-28-boot-and-git-loader-slowness-assessment.md` (root-cause assessment) — this is its task #2.

## Context

First-subscribe to a conversation's `edited-files` and `commits-graph.{delta,graph}`
live-state resources is recorded at **~7 s** on main. The git compute runs **on the
subscribe/loader critical path** under the host-wide `withHeavyReadSlot` gate
(`floor(cpus/4)` = 4 host slots, 2 per-worktree local on this 18-core box). Of
`commits-graph`'s ~4.89 s avg loader, only **~126 ms is real work** — the other
~4.7 s is *waiting for a heavy-read slot* during the cold-boot burst. Because the
loader is awaited inline, that wait sits on the path to first paint and starves the
event loop (a 0.12 ms indexed `tasks` query gets recorded at 1.2 s purely from
queueing behind it).

Prior work already added every reasonable cache layer (per-worktree memo with a
generation/SHA signature, @parcel watcher as authoritative writer, single-flight
coalescing, the two-tier gate). It's still 7 s because the fix was applied one
layer too high: **we synchronously compute a slow, gated thing on the hot path.**
The root-cause fix is to take the git work *off the critical path*, not to cache
its output again.

**Goal:** the loader returns the last-known value cheaply (no *gated* git, never
blocks); the git compute runs in the **background**, bounded by the existing gate +
single-flight, and `notify()`s when it lands. Sub-ack drops from ~7 s to "DB read +
cheap probe"; the chip/badge appears post-paint when the real value arrives. Ship
with an **honest empirical before/after** through the `benchmark_boot` harness.

### Why this is sound here (verified)

- `handleSub` (`plugins/framework/plugins/resource-runtime/core/runtime.ts:1640`)
  awaits `onFirstSubscribe` **then** the loader (`getResourceValue`) before sending
  the sub-ack. The cascade flush (`drainEntry`, `runtime.ts:1393/1436`) **also**
  awaits the loader — so a `refHeadResource` advance mid-storm re-runs the gated git
  on the flush path too. **The deferral must live in the loader**, which covers both
  paths; `onFirstSubscribe` stays as-is.
- The commits chip hides itself while `pending` and when `mergeBase === null`
  (`commits-graph/web/components/commits-chip.tsx:19,21`). An `EMPTY_DELTA`
  placeholder has `mergeBase: null`, so the chip renders **nothing** until the real
  value pops in — **no "0 ahead" confident-wrong-data flash.** edited-files goes
  empty→populated (badge appears), also not wrong data.
- Neither resource is `bootCritical` (no declaration in their `server/index.ts`), so
  they're outside the boot snapshot — converting them does not touch boot-snapshot.
- The only runtime callers of `getEditedFiles` are this resource loader and
  `review/plugin-changes` (disabled). The compute path can be left intact for them
  while the loader stops calling it.

## Design

### 1. edited-files — loader reads the watcher snapshot, never computes

Files: `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/`

- `watch-edited-files.ts`: add accessor `lastEditedFiles(wt): EditedFile[] | null`
  returning the room's `lastFiles` (or `null` if no room). Store the in-flight
  initial compute as `room.opening = openRoom(room)` (the `opening` field already
  exists) so the benchmark `settle` hook can await it.
- `edited-files-resource.ts`:
  - **loader** returns `lastEditedFiles(wt) ?? []` — a pure in-memory read, **no
    `getEditedFiles`, no heavy slot, never blocks.**
  - **remove the `first`-skip** (lines ~29–34) so the watcher's initial `openRoom`
    fanOut fires `editedFilesResource.notify({ id })` → client refetch → loader now
    returns the populated `room.lastFiles`. (Today the skip exists only because the
    loader pre-populated synchronously; it no longer does.)
  - add `settle({ id })`: `await room.opening` for the conversation's worktree
    (benchmark-only; see §4).
- `get-edited-files.ts`: **parallelize the spawns** in `computeEditedFiles` — wave 1
  `[merge-base, status --porcelain]` (status is independent of mergeBase), wave 2
  `[diff --name-status, diff --numstat]` (both need mergeBase). Cuts 4 serial spawns
  to 2 waves → shorter slot-hold → less gate contention. `getEditedFiles`/
  `computeEditedFiles` otherwise unchanged for on-demand callers.

### 2. commits-graph — deferred, non-blocking loaders

Files: `plugins/conversations/plugins/conversation-view/plugins/commits-graph/server/internal/`

- `resources.ts`: convert `commitDeltaResource` + `commitsGraphResource` from
  `defineResource` to **`defineExternalResource`** — the only way to a callable
  `notify()` (`runtime.ts:615`). Keep `dependsOn` (pushes + refHead), `mode: "push"`,
  and the `activeDelta/GraphAttempts` Set bookkeeping. Document at the call site why
  the hand-notify is sound (DB-derived inputs already invalidate via the
  `pushesResource` `dependsOn` cascade; the hand-notify signals only *git-compute
  completion*, which is truth outside Postgres — the same justification edited-files
  already relies on). The `no-db-backed-notify` check passes (no literal `db.` in the
  `defineExternalResource(...)` span; DB access is via `getAttempt`/
  `listPushesForAttempt`).
- `compute-graph.ts`: add a small **per-plugin deferred scheduler** (NOT a shared
  `git-read-cache` helper — see §5). The loader path becomes:
  1. cheap **ungated** signature probe (existing `probeHeadMain` / `probeGraphState`).
  2. cache **hit** under the current signature → return cached value (no schedule).
  3. **miss** → return **last-known-or-placeholder** *out of band* (do **not** write
     the placeholder under the new signature — that would self-satisfy the next probe
     and permanently strand stale data) AND, single-flighted per worktree (reuse the
     existing worktree-keyed inflight / `graphInflight`), launch a background compute:
     `recordEntrySpan("loader", "commits-graph.delta#bg", () =>
     withHeavyReadSlot(computeDeltaCore...))` → write `{newSig, value}` → invoke an
     injected **fanout** callback. Wrapping in `recordEntrySpan`
     (`runtime-profiler/core`) keeps the background heavy-read wait + `workMs` visible
     in `runtimeProfile.loaders` (measurement honesty — §4).
  - **Fanout lives in `resources.ts`, not the scheduler**: on completion, notify
    **every** `activeDeltaAttempts` / `activeGraphAttempts` whose worktree matches
    (the memo/cache are worktree-keyed and `inflight` collapses the N attempts onto
    one compute — notifying only the triggering attempt would leave the other N−1
    chips stale). The scheduler takes `onSettled(wt)` and calls it; `resources.ts`
    maps wt→active attempts and notifies each.
  - **Termination:** after the background notify, the reload probes the now-fresh
    signature → hit → no reschedule. If a ref advanced in between (sig moved again) it
    reschedules — correct, and terminates when git settles. Detached promise uses the
    `void p.catch(...)` + eslint-disable pattern already used in `watch-edited-files.ts`.
  - `computeDeltaCore`: parallelize `branch` / `mergeBase` / `readDeltaCounts` (all
    independent) into one `Promise.all`.

### 3. Concurrency bound

Unchanged gate: the background computes still acquire `withHeavyReadSlot`, and the
per-worktree inflight collapses same-worktree fan-out. With git off the critical
path, the slot **wait** no longer blocks anyone — it only delays the post-paint
populate. No gate-size change needed; the benchmark's `loadConcurrency` confirms the
sub-ack stays flat under a saturated gate.

### 4. Benchmark harness — honest before/after

Files: `plugins/framework/plugins/resource-runtime/core/runtime.ts`,
`plugins/debug/plugins/profiling/plugins/boot-bench/{shared/endpoints.ts,server/internal/handle-run.ts}`

Without this, the loader looks ~instant but the real work moves to a **detached,
unmeasured** place → a fake "7 s→0" win. Minimal honest changes:

- Add optional `settle?: (params) => Promise<void>` to the resource definition
  (generic, string-keyed lifecycle hook, no resource names in the runtime). Each
  deferred resource resolves it when the current background compute for that params'
  worktree completes (edited-files: `await room.opening`; commits-graph: await the
  worktree's scheduler inflight, resolved if none).
- `measureSubscribeCycle` (`runtime.ts:1892`): after the loader (`loaderMs` =
  sub-ack), `await entry.settle?.(p)` and record **`firstPopulateMs`** (from `t0`),
  then teardown. Background compute (wrapped in `recordEntrySpan`) now runs **inside**
  the measurement window, so its waits/work still land in `runtimeProfile.loaders`.
- `endpoints.ts`: add `firstPopulateMs` to the `firstSubscribe[key]` shape.
- `handle-run.ts`: surface `firstPopulateMs`; **retire `SETTLE_MS = 150`** (the
  eviction race it papers over is gone once `settle` is awaited before teardown).

Headline metrics to report: **sub-ack latency** (the ~7 s number → DB read + probe)
AND **time-to-populate** (`firstPopulateMs` → the real, still-gated git work, lower
with the parallelized spawns), plus event-loop max-lag during the burst, both
isolated and under `loadConcurrency ≥ 4`.

### 5. Rejected: shared `getDeferred` in `git-read-cache`

The notify fanout needs attempt-level knowledge (`activeDelta/GraphAttempts`) the
generic worktree-keyed memo deliberately lacks; `commits-graph.graph` uses a bespoke
two-half cache, not the single-signature memo; edited-files bypasses the memo on the
read path entirely (watcher snapshot). A shared helper would serve only
`commits-graph.delta` and still leak orchestration. Keep the deferral per-plugin;
revisit unification only if a third consumer appears.

## Critical files

- `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/{edited-files-resource.ts,watch-edited-files.ts,get-edited-files.ts}`
- `plugins/conversations/plugins/conversation-view/plugins/commits-graph/server/internal/{resources.ts,compute-graph.ts}`
- `plugins/framework/plugins/resource-runtime/core/runtime.ts` (`settle` hook + `measureSubscribeCycle`)
- `plugins/debug/plugins/profiling/plugins/boot-bench/{shared/endpoints.ts,server/internal/handle-run.ts}`
- Reuse: `recordEntrySpan` (`@plugins/infra/plugins/runtime-profiler/core`),
  `withHeavyReadSlot` (`@plugins/infra/plugins/host-read-pool/server`),
  existing worktree-keyed `createInflight` / `graphInflight` in `compute-graph.ts`.

## Verification

1. **Baseline (before):** on current `main`, run `benchmark_boot`
   (`worktree: "singularity"`, `mode: "both"`, then again with `loadConcurrency: 4`)
   and save the JSON. Expect `firstSubscribe.{edited-files,commits-graph.delta,
   commits-graph.graph}.loaderMs` ~ multiple seconds, rising under load.
2. Implement §1–4, then `./equin build` in the worktree.
3. **After:** re-run the identical `benchmark_boot` calls (pin the same
   `conversationId`/`attemptId` via the params the baseline reported). Expect:
   - `loaderMs` (sub-ack) drops to low-ms and **stays flat under `loadConcurrency`**
     (proof it left the critical path / gate wait).
   - `firstPopulateMs` reflects the real git work, **lower than the old `loaderMs`**
     thanks to parallelized spawns; its `runtimeProfile.loaders["…#bg"]` entry shows
     the heavy-read wait that used to be on the sub-ack path.
   - event-loop `maxMs` during the burst drops materially.
4. **Functional:** open a conversation in the app
   (`http://<worktree>.localhost:9000`), confirm the edited-files badge and commits
   chip appear (populated, correct counts) within a beat of load; commit/rebase in
   the worktree and confirm both update live (watcher + refHead cascades intact);
   land a push and confirm the chip's push count updates.
5. `./equin check` (boundaries, no-db-backed-notify, lint, type-check) clean.
6. Optional: `bun test plugins/debug/plugins/profiling/plugins/boot-bench` (extend
   `aggregate.test.ts` for the new `firstPopulateMs` field).

## Risks (from design review)

- **High:** notify fanout must hit all attempts on a worktree (§2) — else silent
  stale chips. Mitigated by fanning out over `activeDelta/GraphAttempts`.
- **High:** placeholder must not be cached under the new signature (§2) — else
  permanent staleness. Mitigated by returning it out of band.
- **High:** background compute must be `recordEntrySpan`-wrapped (§4) — else the
  benchmark goes blind and reports a false win.
- **Medium:** `defineResource`→`defineExternalResource` conversion; document the
  hand-notify justification for reviewer/`no-db-backed-notify`.
- **Low:** detached-promise lint (known `void p.catch` pattern); one extra ungated
  `rev-parse` per reload during a storm (no gate impact).
