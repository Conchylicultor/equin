# A slow leaf loader no longer holds the live-state flush loop

## Context

`conversations.context-usage` is a round trip to the live agent process
(`runtime-sdk/machine/internal/sdk-runtime.ts` `contextUsage`), which blocks
while the agent is busy (2–10 s). The 2026-10-29 audit saw every `push
deliver:*` in the same window equal to that loader's duration.

**Re-measured on main 2026-10-30** (after own-time judging and
one-cause-one-report landed), `slow_ops` samples:

| time (UTC) | context-usage loader | flushNotifies | other deliveries right after |
|---|---|---|---|
| 13:05:44.94 | 2653 ms | 2656 ms | partial-message 2663 ms (+13 ms) |
| 13:25:03.26 | 2950 ms | 3047 ms | jsonl-events 2021, queue-health.pulse 3375, notifications.unread 3190 (+80–110 ms) |
| 14:02:30.85 | 2939 ms | 2941 ms | queue-health.pulse 3910 (+14 ms) |

So it still happens. The other deliveries land just after the pass ends: they
are notifies that arrived **mid-pass** and waited for the next pass.

## Root cause

`flushNotifies` (`framework/resource-runtime/core/runtime.ts`) runs one pass at a
time: `runFlushPass` awaits every topo level's `Promise.all(level.map(drainEntry))`,
and a notify arriving meanwhile only flips `flushState` to `rerun` — its drain
waits for the whole current pass. Same-level entries already run concurrently;
the head-of-line block is **pass-level**: one slow drain holds every later
change, for every resource.

The pass barrier exists for one reason: a cascade (`dependsOn` / `recomputeOn`
edge) must be merged into a deeper entry before that level drains. An entry
with **no downstream** (a leaf — every membership entry by D32, and most values,
context-usage included) has nothing deeper waiting on it.

## Design: leaf drain lanes

1. **A leaf's drain is a lane, not part of the pass's critical path.**
   `runFlushPass` still walks the levels; for each entry with downstream it
   awaits `drainEntry` as before (barrier preserved). For a leaf it starts a lane
   (`entry.lane`), and does not await it on the critical path.
2. **The loop takes the next pass once the critical path is done**, not once
   the lanes settle: `runFlushPass` signals `release()` after its last level;
   the loop races that against the pass's settle. The pass's `flush` span
   (`wrapFlush`) still awaits all its lanes before closing — so every lane's
   `push` loads and `deliver:<key>` leaves stay inside an OPEN flush entry, and
   the profiler's claim/latency judging (`claimEnclosing` skips closed entries)
   keeps working: one slow loader → one report. Flush-span count is unchanged
   (one per pass); passes may now overlap in time.
3. **One drain per entry at a time** (versions / keyed snapshots advance
   monotonically): a pass skips a leaf whose lane is in flight, leaving its
   pending (and a debounced entry's `debounceDue`) held; the lane re-arms on
   settle (`scheduleFlush` if `debounceDue`, else `armFlush` when pending/acks
   remain). It also re-arms any downstream that a cascade fed meanwhile (an
   entry that gained a downstream edge after its lane started). An entry with
   downstream whose (stale) lane is still in flight is awaited first.
4. **A lane never rejects**: an unexpected drain throw is reported
   (`reportLoaderError("drain failed for <key>")`) — loud, not swallowed — and
   the lane still clears. A pass-wrapper failure after release is reported
   the same way as before (`flush pass failed`).
5. **Stall visibility**: `pushStallMs` also counts the oldest in-flight lane's
   start (its pendings left `pendingNotifies` when the drain took them).

Generic: any slow leaf loader (external round trip, slow fs read) stops
holding unrelated updates; no per-resource declaration.

## Files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — `RegistryEntry.lane`
  / `laneStartedAt`, `runFlushPass(release)`, `flushNotifies` race, lane start /
  settle, `pushStallMs`.
- New test `runtime-leaf-lanes.test.ts`: a blocked leaf loader does not delay
  another resource's later notify; the blocked leaf's notifies landing mid-lane
  deliver once it settles (latest value); a cascade upstream still lands before
  its downstream drains; the flush wrapper stays open until the lane settles.
- `framework/resource-runtime/CLAUDE.md` / profiler MCP description if they
  describe a pass as blocking.

## Verification

- `./equin test plugins/framework/plugins/resource-runtime`.
- `./equin check`, `./equin build`.
- After landing: `slow_ops` — a slow `conversations.context-usage` loader no longer
  has other `deliver:*` samples of equal duration within ~100 ms.
