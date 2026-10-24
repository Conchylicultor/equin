# Post-boot herd amplifier — two cheap class-wide containment levers

**Date:** 2026-07-01
**Category:** global (live-state client primitive + build server)
**Status:** plan — awaiting implementation
**Companion issue:** [`research/perfs/issue-cold-boot-fanout.md`](./perfs/issue-cold-boot-fanout.md)

## Context

On `singularity` (main) a backend restart intermittently takes **~46 s** instead of the
warm **~10 s**. Prior perf sessions (see the companion issue) traced this to a **post-boot
herd** with two compounding drivers:

1. **Rate.** Every `./equin push` advances `refs/heads/main` → git-watcher fires
   `git.refAdvanced` → auto-build → the backend restarts. Main reboots **~20×/day**, each a
   cold boot.
2. **Amplitude.** On every restart (and every WS reconnect), each open tab's `replaySubs()`
   re-subscribes **all ~30 live-state resources at once, synchronously**, and the whole fleet
   shares a **fixed 500 ms** reconnect backoff — so every tab cold-misses its loaders in the
   same instant. That burst saturates the per-backend **10-slot DB loader gate** + the single
   event loop, stretching the warm block into the 40–75 s tails. This herd amplifies **every**
   post-boot event-loop block, not just any one hot op.

This plan lands the **two cheap class-wide levers** that bound the amplifier:

- **B′** — cut herd **amplitude** (reconnect jitter + resubscribe stagger, client-side).
- **C** — cut herd **rate** (trailing-debounce auto-builds so a burst of pushes = 1 restart).

### Altitude — read before closing anything

**These are containment, not the cure.** Per the `perfs-investigation` method, the *origin*
of the amplification is that route-parametrized resources (`edited-files`,
`commits-graph.delta`, `jsonl-events`, keyed per conversation/attempt) are **not** in the L2
boot snapshot, so every restart cold-recomputes them fleet-wide *even when their data did not
change* — the illegitimate no-op work. The clean origin fix is to extend the proven snapshot +
bounded-catch-up machinery (`ca4d2cd92`) to **actively-subscribed parametrized resources** — a
larger, separate task tracked in the companion issue.

- **C** reduces *how often* the herd fires (rate axis).
- **B′** reduces *how much each herd hurts* (amplitude axis).

Neither makes the wasted cold-recompute *not happen*. They are worth landing (cheap, help
every post-boot block) **provided the origin task in `issue-cold-boot-fanout.md` stays open.**

### Scope decisions (confirmed with user, 2026-07-01)

- **Server-side sub-admission cap: DEFERRED.** The DB `loaderDbGate` (10 slots,
  `plugins/database/server/internal/client.ts`) already backstops pool exhaustion — the tail
  is a *queueing* symptom of burst-rate > service-rate, which B′.1+B′.2 attack at the source.
  A bespoke server cap now risks half-building the planned "work-admission scheduler"
  (`plugins/framework/plugins/resource-runtime/core/runtime.ts` ~line 53). Ship B′.1+B′.2+C,
  **re-measure** (`benchmark_boot` + live profile), then decide if a cap is still warranted.
- **Debounce window: 5 s.**

## Changes

### Lever B′.1 — reconnect jitter

**File:** `plugins/primitives/plugins/networking/web/shared-websocket.ts`

`scheduleReconnect()` (~line 169) currently waits exactly `BACKOFF_MS[min(attempt, …)]`, so
every tab closed by the same restart wakes at the same millisecond.

- Multiply the looked-up delay by a fresh random factor **each call** (not baked into the
  constant array, so repeated cycles from one tab don't resonate). Mirror the existing idiom
  in `fetch-with-retry.ts:28` (`Math.random() * 0.3 + 0.85`) but with a wider band, e.g.
  `delay * (0.5 + Math.random())` → spread the fleet across ~0.5–1.5× the base backoff.
- `attempt` bookkeeping is untouched; only the `setTimeout` delay changes.

### Lever B′.2 — resubscribe stagger

**File:** `plugins/primitives/plugins/live-state/web/notifications-client.ts`

`replaySubs(channel)` (~line 494) loops over `channel.subs.values()` and calls `sendSub` for
each synchronously — one tab dumps ~30 cold sub-ack loads in one microtask.

- Change signature to `replaySubs(channel, opts: { stagger?: boolean } = {})`, default
  `stagger = true`.
- When staggering: send in small batches (~5–8 subs) with a short inter-batch delay
  (~100–200 ms), **capped total spread** (≤ ~2–3 s regardless of sub count). Reset
  `sub.version`/`sub.lastAckVersion` to `-1` **and** call `sendSub` *together, per-sub, at its
  batch's fire time* — never reset all up front (the server holds no sub state until `sendSub`
  actually goes out, so no premature frame can arrive for a not-yet-resent sub).
- When `stagger: false`: keep today's synchronous single-loop behavior byte-for-byte.
- **`openChannel` `onopen` (~line 467):** keep calling `replaySubs(channel)` with the default
  (staggered) — this is the real herd path (reconnect-after-restart **and** first page load).
- **`probeMissedUpdates` (~line 311):** call `replaySubs(channel, { stagger: false })`
  explicitly. **Load-bearing:** the probe resets `lastAckVersion = -1`, waits a fixed
  `settleMs` (1500 ms), then reads `lastAckVersion`. A staggered sub in a late batch would
  still read `-1` when the timer fires → the missed-update condition
  (`lastAckVersion > prevVersion`) silently never fires → a genuine miss goes undetected. The
  probe is a single-tab watchdog, not part of the fleet herd, so it must stay synchronous.

### Lever C — debounced auto-build (option "C2", localized)

**Files:** `plugins/build/server/internal/build-run-job.ts`, a new
`plugins/build/server/internal/build-run-debounced-job.ts`, `plugins/build/server/index.ts`.

Keep the declarative `Trigger({ on: refAdvanced.where({refName:"refs/heads/main"}), do:
buildRunJob, with: {} })` **exactly as-is** — zero changes to the load-bearing events layer
(rejected option C1, which would migrate `TriggerSpec` + every trigger table for a
single consumer). Split the one job into two:

- **`buildRunJob`** ("build.run", `dedup: "singleton"`) — still the Trigger's target, still
  fires on every `refAdvanced`. Its `run()` no longer calls `triggerBuild` directly; it does:
  ```ts
  await buildRunDebouncedJob.enqueue({}, { runAt: new Date(Date.now() + DEBOUNCE_MS) });
  ```
  with `DEBOUNCE_MS = 5_000` as a module constant.
- **`buildRunDebouncedJob`** ("build.run.debounced", `dedup: "singleton"`, new file) — its
  `run()` holds today's body verbatim: `if (!isMain()) return;` → `autoBuild` guard →
  `triggerBuild("auto")`.

**Why this debounces:** `buildRunDebouncedJob`'s singleton `dedup` maps to graphile jobKey
`build.run.debounced:_`. graphile-worker's default `jobKeyMode: "replace"` (verified against
the installed `graphile-worker@0.16.6` SQL) pushes `run_at` forward via
`ON CONFLICT (key) DO UPDATE SET run_at = excluded.run_at` for any not-yet-started job — so
each push within the 5 s window re-arms the timer → a burst collapses to **one** build =
**one** restart.

- **`build/server/index.ts` `onReady` boot catch-up:** change the `getMainAhead().count > 0`
  branch to enqueue **`buildRunDebouncedJob.enqueue({})`** (no `runAt` ⇒ immediate) — on boot
  we already know we're behind and there's no burst to debounce against; routing through
  `buildRunJob` would add a pointless 5 s delay.
- **`register`:** add `buildRunDebouncedJob` alongside `buildRunJob`.
- **Comment to add** at the debounced enqueue site: if a push lands in the sub-ms window while
  `buildRunJob.run()` is *locked* (executing), the key clears and a fresh row is inserted
  rather than merged — harmless because that body is fire-and-forget (`triggerBuild` returns
  without awaiting the build), so the locked window is sub-millisecond.

## Critical files

- `plugins/primitives/plugins/networking/web/shared-websocket.ts` (B′.1)
- `plugins/primitives/plugins/live-state/web/notifications-client.ts` (B′.2)
- `plugins/build/server/internal/build-run-job.ts` (C)
- `plugins/build/server/internal/build-run-debounced-job.ts` — **new** (C)
- `plugins/build/server/index.ts` (C — register + onReady)

Reuse / reference:
- `plugins/primitives/plugins/networking/web/fetch-with-retry.ts:28` — existing jitter idiom.
- `plugins/infra/plugins/jobs/server/internal/registry.ts:256` — `enqueue(input, { runAt })`
  + singleton→jobKey mapping (the debounce substrate).
- `plugins/build/server/internal/run-build.ts` — `triggerBuild` + in-flight/DB lock (unchanged;
  still the coalescer of *overlapping* builds).

## Correctness risks (and mitigations)

- **Probe false negatives** — mitigated by `replaySubs(…, { stagger:false })` on the probe path.
- **Delayed first paint** — none: first paint is served by `boot-snapshot`'s pre-render HTTP
  hydration, not the WS resubscribe path. Staggering only delays a *resync of an
  already-rendered value* after reconnect, by ≤ the bounded batch spread.
- **Wedged build lock** — none: `inflight` + `build_runs_inflight_uniq` + `reconcileOrphanBuilds`
  are untouched by the job split.
- **Debounce swallowing a push during an in-flight build** — pre-existing, already self-healed
  by the `onReady` `getMainAhead()` check; still holds (same `triggerBuild`).

## Verification

1. **Build:** `./equin build` (run from this worktree). Confirms the new job registers and
   `plugins-*-in-sync` / boundary checks pass.
2. **Lever C — debounce:**
   - Enqueue two `refAdvanced` bursts within 5 s (e.g. two quick no-op commits on a scratch
     main-like ref, or manually enqueue `buildRunJob` twice) and confirm via
     `mcp__singularity__query_db` on `_buildRuns` (or the Build history pane) that **one**
     `build_runs` row is produced, not two.
   - Confirm a lone push still builds after ~5 s.
   - Confirm boot catch-up still builds immediately (no 5 s delay) when main is ahead on boot.
3. **Lever B′ — stagger/jitter:** with `localStorage.liveState.verboseTrace = "1"`, reconnect
   the socket (restart the backend) and read `logs/live-state.jsonl`: `sendSub` lines for one
   `replaySubs` should be spread over time (batched), not all at one timestamp. Confirm
   `probeMissedUpdates` still emits its `sub-ack` lines synchronously.
4. **Amplitude — the payoff:** re-run `mcp__singularity__benchmark_boot` and a live
   `mcp__singularity__get_runtime_profile` after a real restart on `singularity`; compare the
   cold sub-ack fan-out window and `[acquire]`/`flushNotifies` maxima against the baseline in
   the companion issue. **This is the gate** for deciding whether the deferred server-side cap
   is still needed.
5. **Update `research/perfs/issue-cold-boot-fanout.md`** with the re-measured numbers and note
   that the origin (snapshot-serve of parametrized resources) remains open.
