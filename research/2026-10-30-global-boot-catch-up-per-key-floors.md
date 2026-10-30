# Boot catch-up replays an hour of history: route each replayed row only to the keys that lack it

**Date:** 2026-10-30 · **Category:** global (live-state-snapshot, resource-runtime, change-feed)
**Task:** task-1793317080-kjrocf · **Parent:** task-1793316435-l5wuoq (audit task-1793313534-w54p8d)
**Related:** research/2026-10-30-global-cross-boot-resubscribe-resume-epoch.md (task-1793368132-bk33ds, the cross-boot handoff and its cut)

## Context

On main, `runBootCatchUp` replays a median of 9,127 changelog rows per boot
(p90 28,784, max 373,855). The replay floor is ONE number: the oldest usable
row's `position` (`probeCatchUp`'s `min(position)`), and every row at or above it is
routed to every persisted key.

Main's `live_state_snapshot` at 14:32 (now_xmin 42996650):

| key | position | what pins it |
|---|---|---|
| attempts, task-categories, op-store.in-flight.all, task-tracks.all | 42928615 (13:30 compact) | alias: floor persists only `LEAST` the position |
| saved-themes.list, agents.roster, agent-launches | 42928615–17 (13:30 compact) | idle: nothing routed to them since |
| conversations-active/-system | 42974175 (14:14) | alias |
| tasks, notifications.unread, icons…, conversations-gone:count | ≥ 42988772 | recent replace |

That gives 22,328 changelog rows since the floor. **95% of them are tables no persisted key
reads**: `job_runs` / `job_run_stats` 7,016 each, `conversations_ext_sdk_agent` 3,664 and
`event_emissions` 1,064. The rows that matter are few:
- for `attempts`, about 440 (conversations / attempts rows since 13:30);
- for `tasks`, about 55 since its own position.

Yet each key also gets every row between the global floor and its own position. Each such
row is already reflected in that key's value: its row's position is the xmin of the read it
was computed from, so every `xid < position` committed before that read. Routing it marks
the key dirty for nothing. Each such mark is a scoped refill (recursive tasks /
conversations CTEs) and then a `live_state_snapshot` INSERT. That is the 0.5–1.8 s work
3–9 s after boot.

Correctness bar (the reason catch-up exists): a key must still receive every change
since its own position. Nothing is shortened below what a key's own row proves.

## Approach

### A. Per-key replay floors (this task)

Route a replayed changelog row to a persisted key's `{}` tuple only when
`row.xid >= floorOf(key)`. Every other target is routed exactly as today: a subscribed
tuple, a non-persisted entry, a key recomputed at boot.

**Soundness.** A usable row at `position P` holds a value read under a snapshot whose
xmin was P (a replace persist uses the flight watermark; a floor persist uses the
alias's base floor, which is `≤` that). Every transaction with `xid < P` had finished
before that read, so the value reflects it. Re-routing it only re-derives the same value.
A row at `xid ≥ P` is routed as today, so no change since P is ever skipped.

**Which floor per key.** `floorOf` is the lowest position this boot read for the key:
- the probe/read-set read, and the seed read for an alias (the min of the two, the same
  rule `replayFloor` already applies to the hot-swap race where the previous backend
  floor-persists in between);
- a key recomputed at boot (no usable read-set, pruned past, `invalid`), or one with no
  row → no floor → routed as today.

**No downstream guard needed.** A dependsOn downstream learns of a change only
through its upstream's drain. But a persisted entry is never external, and every
`dependsOn` upstream must be external (T15), so a persisted entry has no
downstream to starve.

**Global SELECT unchanged**: `xid >= min(floor)`. The router drops the rows that reach
nothing (unread tables) or reach only keys that already reflect them. Parsing ~20k
rows is a few hundred ms of CPU at worst, against seconds of DB work today. Narrowing the
read by table is a possible follow-up, but it is not sound alone: subscribed non-persisted
tuples need every row.

**Shape (clean API, no new concept beyond "replay"):**
- `resource-runtime/core`:
  - `routeTableChange(change, replay?: ReplayScope)`, where
    `ReplayScope = { xid: string; floors: ReadonlyMap<string, string> }`. In
    `routedTargets`, the `{}` target of a persisted entry is skipped when
    `replayReflected(entry, scope)` holds: the entry has a floor and
    `BigInt(xid) < BigInt(floor)`.
  - The `ack` `xid` stays unset on a replay. `replay.xid` is only a floor comparison,
    never an ack.
  - Counters for `_debug`: `replaySkippedTargets`.
- `server-core` passes the scope through (`routeTableChange` binding).
- `change-feed`: `createChangeRouter` / `routeChange(routed, replay?)` pass the scope
  through. This is the single router, so the invariant "catch-up ≡ the live path" still
  holds: a replay is the live routing minus targets proven current.
- `live-state-snapshot`:
  - `probeCatchUp` returns the per-key positions with the floor. It is one query,
    `SELECT resource_key, position` over the usable rows, with min in JS. So the global
    floor and the per-key floors come from the same statement.
  - `runBootCatchUp`:
    - builds `floors`, dropping every key it recomputes;
    - lowers a key's floor to its seeded position;
    - passes `floors` to `replayCatchUp`, which hands `{ xid: row.xid, floors }` to `route`.
  - The log line reports the rows read, and how many reached any target.

### B. Raise an alias's floor above its last FULL rebuild (coordinated, may follow)

After A, the replay a key gets is bounded by its own position. For a persisted alias that
position still sits at its last FULL (a compact up to an hour ago), because a floor
persist can only `LEAST` it. It is sound to raise it only to a **routed-through cut**:
- an xmin X;
- a barrier NOTIFY committed after X, received through change-feed's burst router after
  every earlier transaction's changes;
- the tuple then drained.

That is exactly the cut the handoff design (task-1793368132-bk33ds) needs at shutdown, so
it is one primitive with two consumers. **Agreed with that agent:** it builds
`change-feed/server`'s `feedCut(): Promise<{ cutXid }>`:
1. capture the xmin;
2. send a barrier NOTIFY on the listener's session;
3. resolve once the burst router has routed everything held before the barrier.

B is then filed as a follow-up on that primitive. A floor persist awaits a coalesced
`feedCut`, then checks that the tuple has no pending, no drain and no flight. It then
writes `position = cutXid` in an `advance` mode that sets the position instead of taking
`LEAST`. This diff does only A.

A alone takes the replay from "every row since the global min" to each key's own
relevant rows. On today's data that is about 440 + 214 + 80 + 55 + 13 rows routed to
any key, against 22,328, and the refills coalesce per drain.

## Critical files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts`: `routeTableChange`, `routeEntryChange`, `routedTargets`, and a `ReplayScope` type (`core/routing.ts`).
- `plugins/framework/plugins/server-core/core/resources.ts`: the binding.
- `plugins/database/plugins/change-feed/server/internal/route-change.ts`: `routeChange` and `createChangeRouter`, with the scope passed through.
- `plugins/database/plugins/live-state-snapshot/server/internal/{catch-up,boot-catch-up}.ts`
- `plugins/database/plugins/live-state-snapshot/CLAUDE.md`: the *Boot flow* step 4, the per-key floor rule and its soundness.

## Verification

- **Runtime harness** (a new `core/runtime-replay-floors.test.ts`): a persisted
  `{}` target gets no pending for a replay row with `xid < floor`, and does get one at
  `xid == floor` and at `xid > floor` (the boundary). A subscribed tuple of the same
  entry still gets it. A key absent from `floors` gets it. A persisted key whose
  A live change (no scope) is unchanged. A non-persisted entry is never skipped.
- **DB-backed** (`boot-catch-up.test.ts` / `catch-up.test.ts`):
  - two persisted keys at positions P1 < P2 and changelog rows at P1, between them,
    at P2 and above; key 2 receives only rows `≥ P2`, key 1 all of them;
  - a seeded alias whose seed position is below its probe position gets the lower floor;
  - a recomputed key is routed everything.
- `./equin test plugins/database/plugins/live-state-snapshot plugins/database/plugins/change-feed plugins/framework/plugins/resource-runtime`
- `./equin build`, then restart again and read the catch-up log line (rows read against
  rows routed) and the slow ops within 10 s of boot.
- `./equin check`. Rebase on origin/main before pushing.
