# HANDOFF: "loading a conversation takes 40+ s" → it's a main-thread event-loop block

**Date:** 2026-06-29
**Status:** **Ongoing — hotspot named (`buildPluginTree`), deeper layer found, fix being designed.**
The on-stall JSC flight recorder (`logs/stall-profiles.jsonl`) captured the block: topLeaf
`readFileSync` 59.6 %, stack `readFileSync ← parseRawUses/parsePaneDefinitions ← extract ←
buildPluginTree`, `sampleRateHz 176` (real in-process block, not CPU starvation); the runtime profile
independently shows `GET /api/plugin-view/tree` at 10.3 s with `allow-files`/`viewed` queued right
behind it (loaders = victims, as predicted here). The "Open question" below is **answered at the
hotspot level**, and its suspect list (flush cascade / `stats/*`) was **wrong — both are victims**
(`stats/cost` measured at 18 ms max block). **But the hotspot is not the root:** the per-call cost is
reducible — `buildPluginTree` over-extracts all facets (4408 files, synchronous) for an endpoint whose
hot callers need only the cheap structural skeleton. Root-cause arc + the (cache-first v1, then the
structure-only) fix design →
**[`2026-06-29-perfs-buildplugintree-eventloop-block-FIX.md`](./2026-06-29-perfs-buildplugintree-eventloop-block-FIX.md)**.
**Read this first.** It supersedes the framing in
[`2026-06-29-conversation-load-40s-fanout-herd.md`](./archive/2026-06-29-conversation-load-40s-fanout-herd.md)
(that doc's lower-layer findings are correct but it stopped two layers too low — see "Discarded/superseded" below).
Follow the [`perfs-investigation`](../../.claude/skills/perfs-investigation/SKILL.md) skill: **re-validate, do not inherit.**

---

## The one-sentence finding

The 40 s is **not** DB-pool exhaustion, **not** the git heavy-read gate, **not** distributed fan-out
queueing. It is the **main (`singularity`) backend's single event loop being monopolized by one
synchronous CPU operation for 10–46 s at a stretch**, dozens of times a day. The conversation
loaders (`edited-files`/`commits-graph`/`jsonl-events`) are **victims** — a conversation load takes
"40 s" = however long the event loop happens to be blocked when you open it.

## The decisive evidence (re-validate these first)

Health sampler on main: `~/.singularity/worktrees/singularity/logs/health.jsonl` (one JSON/line under `.line`).

- At **14:46:38** (the 47 s `edited-files` load), the sample was:
  `eventLoopMaxMs: 45854`, `eventLoopP50Ms: 1.0`, `gcPreciseCount: 0`, `heavyReadDepth: 0`,
  `physFootprintMb: 428`. → the loop was blocked ~46 s in **one** stall (a timer fired 45.8 s late).
  Not GC, not git gate, not memory.
- The matching `slow_ops` sample (`recent_samples`) for `edited-files {"id":"conv-1782736714-jbqh"}`
  at that instant: `durationMs: 47336`, **`pgActiveBackends: 3`**, `loadAvg1: 12.5/18`.
  **PG was idle** — because nothing could issue a query during the block. This is what kills the
  DB-pool-exhaustion theory for this event.
- Recurring, today alone: **34 stalls >3 s, 14 stalls >10 s**, peaks 45.8 / 40.2 / 35 / 28 / 24 / 17 s,
  every one with `gcPreciseCount:0` and `heavyReadDepth:0`. Worst ones cluster shortly after a boot
  (herd window) but they happen all day.

Re-run to confirm:
```bash
cd ~/.singularity/worktrees/singularity/logs/
jq -rc 'select(.t>=<today_ms>) | .line | fromjson
  | select(.eventLoopMaxMs>3000)
  | [.sampledAt,(.eventLoopMaxMs|round),.gcPreciseCount,.heavyReadDepth]|@tsv' health.jsonl
```

## Full causal chain (rate × cost, top to bottom)

1. **Trigger frequency (rate):** every `./equin push` advances `refs/heads/main` → main's
   git-watcher fires `refAdvanced` → auto-build job → `POST /gateway/worktrees/singularity/restart`.
   Many agents pushing ⇒ main restarts **~20×/day** (boots every 10–25 min). Chain:
   `cli/.../push.ts:535` → `infra/git-watcher/.../watcher.ts:101` → `build/server/index.ts:20`
   (`Trigger refAdvanced→buildRunJob`) → `build.ts:1097` (restart POST) → `gateway worktree.go:389 Restart()`.
2. **Load spike:** restart = **cold process boot** (in-memory memos/values lost; hot proxy-swap but
   no warm-state handoff — `worktree.go:389-453`). The whole open-tab fleet's WS reconnects and
   **re-subscribes every resource in a tight loop with NO jitter/stagger/admission control**
   (`notifications-client.ts:494-512 replaySubs`; reconnect = single 500 ms backoff
   `shared-websocket.ts:169`).
3. **THE bottleneck (cost — where the 40 s goes):** some **synchronous CPU operation** then runs for
   10–46 s on the single event loop. Everything else (every loader's DB-query callback, every WS
   send, the flush cycle) is frozen behind it. This is the layer all prior sessions missed.
4. **Victims:** the conversation loaders measure 35–47 s end-to-end though their own work is ~1.4 s
   (`benchmark_boot`: `edited-files` 1.4 s, `commits-graph.delta` 0.7 s even with the host git gate
   saturated).

## Open question — the ONE thing left to find ✅ ANSWERED: `buildPluginTree`

> **Resolved (see Status banner + the FIX doc).** The recorder named the block: `buildPluginTree`'s
> synchronous `readFileSync` facet-extract walk, uncached on `GET /api/plugin-view/tree`. **None of
> the leading suspects below were the cause** — they were victims of, or unrelated to, that block.
> Kept verbatim as a record of how the wrong path almost persisted (the profile, not the suspect
> list, settled it).

**Which synchronous operation blocks the loop for tens of seconds?** Leading suspects (from data, unproven):
- **Live-state flush/push cascade** — `flushNotifies` is pure event-loop work (no waits) and recently
  hit **10.5 s** in one cycle (`slow_ops` flush kind, `last_ms`). A herd makes one flush batch huge:
  serialize + diff every changed resource × subscriber, synchronously. Strongest suspect. Code:
  `plugins/framework/plugins/resource-runtime/core/runtime.ts` (`drainEntry`/`flushNotifies`).
- **Stats endpoints** — `GET /api/stats/cost/*` (8 of them) all maxed at **65–77 s simultaneously**
  at 14:35 (shared-stall signature); `/api/stats/commits/*` 25–51 s. Heavy synchronous JS aggregation
  and/or `git log` over the whole repo. Code: `plugins/stats/plugins/{cost,commits}/server`.
- **Host CPU contention** — loadAvg 12.5/18 at the 46 s stall; the box runs ~18 agent worktrees +
  frequent builds. Could starve the thread even without an in-process block. Distinguish via host
  load correlation (`health-host.jsonl`).

### Exact next step
Capture **one CPU profile (or flame chart) of the main backend during a 10 s+ stall**, OR add
lightweight `performance.now()` timing around the flush cascade (`runtime.ts` drain loop) and the
stats handlers and wait for the next stall (they happen ~every 10–25 min). The runtime-profiler
splits work vs wait but a pure-CPU block needs a sampling profiler to attribute the function.
Bun: `bun --inspect` / `--cpu-prof`, or `process` V8 CPU profiler; see `debug/heap-snapshot` plugin
for the existing on-demand-dump pattern to copy. Correlate the stall timestamp (health.jsonl
`eventLoopMaxMs` spike) with the profile.

## Discarded / superseded hypotheses (with the gate that killed each)

- ❌ **DB connection-pool `[acquire]` exhaustion is the cause** (the 2026-06-29 prior doc + my own
  first pass). Killed by gate-1+data: during the 47 s load, `pgActiveBackends: 3` (PG idle). The
  cumulative `[acquire]` max 75.9 s is a *different* moment (sleep/stall), wrongly conflated. The pool
  is a victim, not the driver, of the event-loop block.
- ❌ **Host git heavy-read gate (4 slots) is the cause.** Killed by `benchmark_boot`: saturating it
  adds nothing (loaders stay ~1.4 s); `heavyReadDepth:0` during the big stalls.
- ⚠️ **Serve-stale L2 snapshot for parametrized resources (the plan I was writing).** Not wrong, but
  **demoted from primary cure to at-best-secondary**: if the event loop is blocked 46 s, the stale
  value still can't be *sent* (the WS write is on the same blocked loop). Don't build it until the
  synchronous block is fixed. The detailed serve-stale design (already explored — generic runtime
  `serveStale` flag, `(resource_key, params_key)` persist, catch-up floor must exclude `serve_stale`
  rows via `WHERE serve_stale=false` else the floor drops to 0) is preserved in the fan-out-herd doc
  for if it's still needed later.
- ✅ **Cold-boot fan-out herd is the TRIGGER** — confirmed (boots correlate with the worst stalls),
  but it is the trigger, not where the time goes.

## Cheap levers worth keeping in mind (do NOT lead with them; they're below the bottleneck)

- **B′ — reconnect jitter + resubscribe stagger + server sub admission cap** (`notifications-client.ts`
  `replaySubs` has none). De-amplifies every herd; small, class-wide. Helps but doesn't fix a 46 s
  monoblock.
- **C — coalesce/debounce auto-builds** so N near-simultaneous pushes = 1 restart, cutting the ~20×/day
  restart rate. Origin lever on trigger frequency.

## Evidence index
- Event-loop stalls: `~/.singularity/worktrees/singularity/logs/health.jsonl` (`eventLoopMaxMs`).
- Per-event system snapshot (`pgActiveBackends`, loadAvg): `slow_ops.recent_samples`
  (`query_db` on `singularity`, `operation_kind='element' AND operation LIKE 'edited-files%'`).
- 40 s symptom rows: `slow_ops` ordered by `last_ms`, `last_seen_at > now()-interval '6 hours'`.
- Boots: `~/.singularity/worktrees/singularity/logs/change-feed.jsonl` ("LISTEN live_state established",
  preceded by "installed live_state triggers" = a boot, not a reconnect).
- Loader work in isolation: `benchmark_boot` MCP on `singularity`.
- Restart trigger + client herd code paths: see "Full causal chain" file:line refs above.
