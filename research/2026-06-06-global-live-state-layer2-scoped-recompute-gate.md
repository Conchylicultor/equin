# Live-state Layer 2 (scoped recompute) — gate measurement plan

## Context

Layer 1 (keyed delta wire protocol) shipped in `c2da7a50b feat(live-state):
row-level delta sync via opt-in keyed resource mode` (+ fix `c83757ea1`). It
collapsed the **wire** cost: a conversation status flip now ships a one-row
delta instead of the full ~2268-task / ~2096-attempt array, per socket.

Layer 2 ("scoped recompute") attacks the remaining cost: even after Layer 1, the
`tasks`/`attempts` keyed resources still **rerun the full `tasks_v`/`attempts_v`
query on every `conversationsLive → attempts → tasks` cascade fire** to compute
the diff. Only the wire payload shrank, not the DB recompute. A single
conversation status change affects exactly one attempt and one task, yet all
rows are recomputed.

Per the original design (`research/2026-06-05-global-live-state-delta-sync.md`,
Layer 2 section), this is **explicitly deferred** and **gated on evidence**:

> Build Layer 2 only if, after Layer 1, the profiler still shows DB/`[acquire]`
> contention under load.

**This document is that gate measurement — not an implementation plan.** The
deliverable is a profiler before/after under a conversation-flip burst and a
go/no-go decision. The implementation plan (hot-path-only scope) is deferred and
sketched at the end only as a pointer, to be written iff the numbers justify it.

The pre-Layer-1 baseline already documented: `[acquire]` (pool checkout) and db
spans ballooned to **~340–390 ms** under a burst even though each view executes
in ~20 ms warm. The question this measurement answers: **does that balloon
persist now that Layer 1 removed the per-socket serialization?**

## What we already know (from exploration)

- The cascade fires the loaders only when there are subscribers (keyed arm runs
  the loader when `subs.length > 0`; see `flushNotifies`,
  `plugins/framework/plugins/server-core/core/resources.ts:388-485`). So the
  measurement **requires open tabs** on the tasks list.
- `flushNotifies` coalesces within a microtask: **N synchronous `notify()` calls
  in one event-loop turn collapse to a single flush.** A faithful temporal burst
  must spread fires across separate turns (separate HTTP requests, or `await`
  between calls) to surface pool-checkout queueing.
- The profiler records `db` `[acquire]` (pool queue-wait + pgbouncer connect) and
  `db <sql>` (execution) separately, plus `loader <key>` spans, each with a
  `byParent` breakdown of which loader/route issued them. Read it at the
  **worktree gateway**, not via the MCP tool (MCP reads its own process):
  - `GET  http://<worktree>.localhost:9000/api/debug/profiling/runtime`
  - `POST http://<worktree>.localhost:9000/api/debug/profiling/runtime/reset`
  - Source: `plugins/debug/plugins/profiling/plugins/runtime/`,
    `plugins/infra/plugins/runtime-profiler/core/recorder.ts`.
- There is **no existing debug lever** to drive the cascade synthetically; it is
  driven only by real conversation mutations (poller, resume/exit, etc.). A small
  **throwaway** debug burst trigger is the cleanest isolated generator.

## Measurement procedure

### 0. Build & sanity
1. `./equin build` from this worktree.
2. Confirm the worktree DB fork carries realistic row counts (the cost only
   reproduces at scale):
   `mcp__singularity__query_db` →
   `SELECT (SELECT count(*) FROM tasks) AS tasks, (SELECT count(*) FROM attempts) AS attempts;`
   Expect ~2268 / ~2096. If the fork is near-empty, the measurement is invalid —
   note it and stop (the gate can't be evaluated on an empty DB).

### 1. Subscribe (so loaders actually run)
Open **3+ tabs** on the tasks list (`http://<worktree>.localhost:9000`) and leave
them connected. This subscribes the `tasks` and `attempts` keyed resources;
without subscribers the cascade short-circuits and nothing is measured.

### 2. Burst generator (throwaway debug trigger)
Add a **temporary, uncommitted** debug endpoint that fires the cascade across
separate event-loop turns (not one coalesced flush):

```
POST /api/debug/cascade-burst?n=30
// handler: for (let i=0;i<n;i++){ notifyConversationsChanged(); await new Promise(r=>setImmediate(r)); }
```

`notifyConversationsChanged()` (`plugins/tasks-core/server/internal/notify-conversations.ts`)
re-runs the exact `conversations → attempts → tasks` cascade — the full
`attempts_v` + `tasks_v` recompute — without launching agents, so it isolates the
DB recompute that Layer 2 targets. Spreading with `setImmediate` defeats
microtask coalescing so each iteration is a distinct flush. To also surface
**pool contention** (the `[acquire]` balloon, not just per-fire loader time),
issue the burst **concurrently with itself**: fire the endpoint from ~5 parallel
`curl` calls so cascade loaders compete with each other for pool connections.

> This endpoint is for measurement only — **do not commit it.** It is the faithful
> isolated lever; the alternative (repeatedly resuming/exiting real conversations)
> drags in agent side-effects and is not repeatable.

### 3. Capture before/after
1. `POST …/runtime/reset` (clears the window).
2. Drive the burst (step 2), concurrently, for a few seconds.
3. `GET …/runtime` and record:
   - `aggregates.db` → the `[acquire]` row: `maxMs`, `totalMs`, `count`, and its
     `byParent` (expect `loader:attempts` / `loader:tasks` as the callers).
   - `aggregates.db` → the `attempts_v` / `tasks_v` execution rows: `maxMs`,
     `lastMs`.
   - `aggregates.loader` → `attempts` and `tasks`: `maxMs`, `lastMs`, `count`.
   - `slowest.db` → top entries during the window.

### 4. Decision criterion (the gate)
- **Layer 2 WARRANTED** if, under the concurrent burst, `db [acquire]` `maxMs`
  still balloons to roughly the documented **~340–390 ms** range (or the
  `attempts_v`/`tasks_v` execution + loader spans dominate the window and scale
  with the full row count). → Proceed to write the implementation plan.
- **Layer 2 NOT warranted** if `[acquire]` `maxMs` stays low (≈ warm execution,
  e.g. < ~50 ms) and loader spans are modest — i.e. Layer 1's removal of the
  per-socket serialization already drained the contention. → **Stop.** Record the
  numbers in this doc and close the task; the full-recompute-per-fire is
  acceptable at current scale.

Capture the raw before/after JSON in this doc under a "Results" heading so the
go/no-go is auditable.

## Results (2026-06-06, worktree `att-1780747437-g8yw`)

**Verdict: Layer 2 is WARRANTED.** Under a concurrent cascade burst the DB
`[acquire]` (pool checkout) wait still balloons into and beyond the documented
pre-Layer-1 340–390 ms range, attributed directly to the cascade loaders
(`conversations`/`attempts`/`tasks`). Layer 1 collapsed the wire payload but did
**not** drain the DB-recompute pool contention.

### Setup
- DB scale (gate-valid): `tasks = 2316`, `attempts = 2146`.
- Subscriptions held live via Playwright: 2 tabs on `/agents/tasks` (subscribes
  the `tasks` keyed resource) + 1 tab on `/a/<attempt>` (subscribes `attempts`).
- Lever: throwaway `POST /api/debug/cascade-burst?n=N` calling
  `notifyConversationsChanged()` once per separate event-loop turn
  (`setImmediate` between calls to defeat microtask coalescing). Fired
  concurrently from P parallel callers to surface pool contention.

### Harness sanity check — PASS
Warmup (light, spaced bursts) reliably produced **all three** cascade loaders
with subs live: `{"tasks":8,"attempts":8,"conversations":8}` per 8-fire burst.
The `[acquire].byParent` breakdown attributes the pool wait to
`loader:conversations` / `loader:attempts` / `loader:tasks` — i.e. the cascade
itself is the contention source, not unrelated traffic. (Note: keyed subs in a
long-idle background browser drop intermittently under a heavy burst, so the
faithful runs hold subs live and fire concurrently in one self-contained
script.)

### Key numbers (three independent runs, all ≥ the documented balloon)

| Run | burst | `db [acquire]` count / maxMs | `[acquire].byParent` (maxMs) | view exec maxMs | loader maxMs |
|-----|-------|------------------------------|------------------------------|-----------------|--------------|
| A — single heavy burst (`tasks` subscribed) | 5 ∥ × n=30 | 159 / **2382.6 ms** | `loader:tasks` 2382.6 | `tasks` SQL 96.5 (last 69.3) | `tasks` 2461.1 (count 150) |
| B — single contention wave (`attempts`/`conv` subscribed) | 5 ∥ × n=30 | 455 / **622.5 ms** | `loader:conversations` 622.5, `loader:attempts` 584.0 | attempts base 85.4, conv subqueries 18–34 | `attempts` 624.1 (15), `conversations` 610.1 (104) |
| C — multi-wave | 4 × 6 ∥ × n=12 | 282 / **393.1 ms** | `loader:conversations` 393.1, `loader:attempts` 379.3 | attempts base 105.8, conv subqueries 14–18 | `attempts` 375.1 (6), `conversations` 393.7 (65) |

In every run the **execution** of the underlying SQL is modest (≤ ~106 ms; the
`tasks` list query ~96 ms warm, conversation subqueries ~15–35 ms) — the cost is
overwhelmingly **pool queue-wait**: concurrent cascade fires each acquire +
recompute the full view, stacking on the limited pool. Run A shows the worst
case (the full ~2316-row `tasks` view recomputed 150× concurrently → 2.4 s
queue tail); runs B/C land right on the documented 340–390 ms balloon even
without `tasks` in the active sub set.

### Raw snippets

Run A — `[acquire]` (attributed entirely to `loader:tasks`):
```json
{ "label": "[acquire]", "count": 159, "maxMs": 2382.62, "totalMs": 182635.88,
  "byParent": [ { "parent": {"kind":"loader","label":"tasks"},
                  "count": 150, "totalMs": 176894.27, "maxMs": 2382.62 } ] }
// loader tasks: { count: 150, maxMs: 2461.1, lastMs: 2461.1 }
// db tasks-view exec: { count: 150, maxMs: 96.5, lastMs: 69.3 }
```

Run C — `[acquire]` (squarely in the 340–390 ms documented range):
```json
{ "label": "[acquire]", "count": 282, "maxMs": 393.12, "totalMs": 51029.8,
  "byParent": [ { "parent": {"kind":"loader","label":"conversations"}, "count": 268, "maxMs": 393.1 },
                { "parent": {"kind":"loader","label":"attempts"},      "count": 14,  "maxMs": 379.3 } ] }
// loader conversations: { count: 65, maxMs: 393.7 }   loader attempts: { count: 6, maxMs: 375.1 }
// db attempts base exec: { count: 6, maxMs: 105.8 }   conv subqueries: maxMs 14.7–18.6
```

### Decision
**GO — proceed to write the Layer 2 (scoped recompute, hot-path-only)
implementation plan.** The `[acquire]` balloon (393 ms baseline, up to 2.4 s
when the full `tasks` view is in the concurrent recompute set) persists after
Layer 1 and scales with the full row count, exactly the contention Layer 2's
`affectedIds`-scoped recompute is designed to eliminate.

## If warranted — implementation direction (DEFERRED, do not build yet)

Recommended scope if the gate is met: **hot path only.** Scope recompute on the
two high-frequency content-only sites and leave everything else on today's full
path. This captures ~all the win with the smallest, safest surface.

- **Server-only.** The Layer 1 wire format already carries scoped deltas
  (`{kind:"delta", upserts, deletes:[], order:undefined}`) — the client needs
  **no changes**.
- **Opt-in `affectedIds` side-channel:** `notify(params, { affectedIds })`;
  `pendingNotifies` accumulates per-pk a union `Set` of ids **or** a sticky
  `FULL` sentinel (any id-less `notify()` forces FULL → today's behavior, correct
  for membership changes).
- **Scoped loader:** `loader(params, ctx?: { affectedIds })` adds
  `inArray(id, ids)` to the `attempts_v` / `tasks_v` outer select — proportional
  work reduction.
- **Partial diff (`diffKeyedScoped`):** upserts = scoped rows whose hash differs;
  `deletes:[]`, `order:undefined`; **merge** the affected ids into the existing
  snapshot (never full-replace). Un-returned affected ids = treated as unchanged
  (the delete site's own FULL notify owns membership correction).
- **Cascade id mapping:** new `affectedMap?(upstreamIds, params)` per
  `dependsOn` edge — `conversationsLive→attempts` (DISTINCT `attempt_id` from
  `conversations_v WHERE id IN`), `pushes→attempts` (identity on `attemptId`),
  `attempts→tasks` (DISTINCT `task_id` from `attempts WHERE id IN`). Must
  **not** force `needValue` (it self-queries; forcing the value reintroduces the
  full load). Missing `affectedMap` or upstream-FULL ⇒ downstream FULL.
- **Sites that get scoped:** the conversation **poller** (`poller.ts:250` — swap
  the boolean `changed` for a `Set<string>` of changed conversation ids; force
  FULL if an orphan was adopted that tick) and **`insertPush`**
  (`mutations/pushes.ts` — it has `attemptId`/`taskId` in scope). **Everything
  else stays FULL:** create/delete/reorder of tasks & attempts, dependency
  mutations, sweep, adopt-orphan.
- **Self-heal:** any missed scoped change is corrected by the next FULL notify or
  a resub (full sub-ack reseeds the snapshot) — so opt-in scoping is low-risk.

Full design + pressure-tests: `research/2026-06-05-global-live-state-delta-sync.md`
(Layer 2 section). A dedicated implementation plan should be written **after** the
gate passes, not before.

## Critical files (for the measurement)

- `plugins/tasks-core/server/internal/notify-conversations.ts` — the cascade lever
  the throwaway burst endpoint calls.
- `plugins/tasks-core/server/internal/resources.ts` — `attempts`/`tasks` keyed
  resource defs + loaders whose recompute we're measuring.
- `plugins/framework/plugins/server-core/core/resources.ts:388-485` —
  `flushNotifies` (coalescing + cascade), to understand fire semantics.
- `plugins/debug/plugins/profiling/plugins/runtime/shared/endpoints.ts` — profiler
  GET/reset endpoints.
- `plugins/infra/plugins/runtime-profiler/core/recorder.ts` — span/`byParent`
  semantics.

## Verification of the measurement itself

- Sanity: with **no tabs open**, the burst should produce ~no `loader:attempts`/
  `loader:tasks` spans (cascade short-circuits) — confirms the harness measures
  the right thing.
- The `[acquire].byParent` breakdown should attribute the wait to
  `loader:attempts` / `loader:tasks`, confirming the cascade (not unrelated
  traffic) is the contention source.
- Remove the throwaway debug endpoint before any commit.
