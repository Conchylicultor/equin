---
name: debug
description: >
  Decision tree for debugging Singularity — start at the alert funnel (Reports)
  and the incident Timeline, THEN branch by symptom to the right surface.
  Read BEFORE debugging anything.
---

# Debugging

Do **STEP 0 first for every symptom**, then follow the one branch that matches.
Two synthesis surfaces are the front door — skipping them is how a plausible
single cause hides a bigger one (a minute-scale span, a never-ready boot).

## STEP 0 — always, before you pick a surface

**Reports — "am I being alerted?"** (Debug → Reports) The alert funnel: every
durable failure signal dedupes here with a source, count, noise flag, a linked
investigation task, and — for perf kinds — a *View-trace* chip to the evidence.
Kinds include crashes, `slow-op` / `op-rate` / `op-time`, queue-health,
boot-budget, event-loop-stall, live-state churn, duress-shed and
session-divergence. A report often already names the layer — start here.
→ [`plugins/debug/plugins/reports/CLAUDE.md`](../../../plugins/debug/plugins/reports/CLAUDE.md)

**Timeline — "what happened when?"** The cross-worktree wall-clock Gantt:
per-worktree lanes of boots (**incl. never-ready bars — a backend wedged
mid-boot shows as an open-ended bar**), builds, traces, slow-ops, reports,
health heat strips, and duress bands. Open **Debug → Slow Events → Timeline**
(its 4th tab — NOT a sidebar pane), or call the `get_timeline` MCP tool for the
symptom window. Read the whole incident window, not the first sufficient span.
→ [`plugins/debug/plugins/timeline/CLAUDE.md`](../../../plugins/debug/plugins/timeline/CLAUDE.md)

> **Do not stop at the first sufficient cause.** The failure this tree prevents:
> open a plausible surface, find a sufficient-looking cause, stop — while a
> longer span or an 11-minute never-ready boot sat unread in a synthesis
> surface. Step 0 surfaces those. Branch only *after* both.

## Branch by symptom

### Slow / freeze / outage — pages take seconds+, UI frozen
`get_runtime_profile` (MCP) — slowest HTTP / DB / loader spans with per-parent
(`byParent`) attribution and a wall-clock split on every entry: **`waitMs`** =
gate/pool layers the subtree queued on (mostly-wait ⇒ head-of-line **victim**,
not the cause); **`selfMs`** = own work (mostly-self ⇒ genuinely slow);
`childMs` = children. Read **`recentMaxMs`** (rolling ~5 min = "slow *now*"), not
`maxMs` (since-boot peak; carries `maxAgeMs`). It 404s on a wedged backend — then
use Health. Durable history survives restarts in `slow_ops` (`query_db`) / the
Slow Events **Aggregates** tab.
- **Debug → Slow Events** (`/debug/traces`) — per-incident **evidence**: each
  threshold trip persists one coherent-instant **trace** (everything in flight +
  every gate's occupancy + host/DB contention) as a **Gantt** for the
  blocking-chain walk. Jump here from a report's *View-trace* chip.
- **Debug → Health** — continuous per-backend **event-loop lag** (p99/max — the
  GC/blocking-stall signal), phys_footprint/heap, plus a host strip (load / mem /
  swap). Reads `logs/health.jsonl` from **disk**, so it works when a backend is
  wedged. Tells a per-backend stall apart from host pressure.
- **`pg_stat_activity`** (`query_db`) by `datname` + `wait_event` — cluster-wide
  lock/backend picture. Slow under load but fast under isolated `EXPLAIN ANALYZE`
  ⇒ **contention**, not a bad plan.
→ [`plugins/debug/plugins/health-monitor/CLAUDE.md`](../../../plugins/debug/plugins/health-monitor/CLAUDE.md) · trace engine [`plugins/debug/plugins/trace/CLAUDE.md`](../../../plugins/debug/plugins/trace/CLAUDE.md)
For a full root-cause pass follow the [`perfs-investigation`](../perfs-investigation/SKILL.md) skill.

### Stale UI — a server change doesn't reach an open tab until refresh
The bug is in the client live-state pipeline (WS → cross-tab leader election →
BroadcastChannel → query cache), not the server. `NotificationsClient` traces
every hop **and every silent drop** to the `live-state` log channel
(`[tabId]`-stamped, over plain HTTP so it survives a wedged WS) — `cat
logs/live-state.jsonl`; the gap localizes the dead hop. **Debug → Live State**
shows live socket/leader/per-resource-version state; a watchdog toasts + files a
`live-state-wedge` crash on stall.
→ [`plugins/primitives/plugins/live-state/CLAUDE.md`](../../../plugins/primitives/plugins/live-state/CLAUDE.md)

### Crash / error
Uncaught browser/server errors are recorded + deduped into tasks (handled
4xx/5xx and mutation errors too); they surface in **STEP 0 → Reports**. The
reports pane lists all, including noise.
→ core [`plugins/reports/CLAUDE.md`](../../../plugins/reports/CLAUDE.md) · crash kind [`plugins/reports/plugins/crash/CLAUDE.md`](../../../plugins/reports/plugins/crash/CLAUDE.md)

### High memory — "why is this backend using N GB"
- **Debug → Heap** (`heap-snapshot`) — `bun:jsc heapStats()` object-type
  breakdown + real **phys_footprint**, plus an on-demand full V8 `.heapsnapshot`
  dump (heavy, blocks the loop seconds — manual only) for offline DevTools.
- **All memory surfaces report `phys_footprint`, not `rss`.** `rss` overcounts
  ~6× on macOS (5+ GB `rss` measured at ~885 MB true footprint — it counts
  clean/reserved/shared pages: JSC Gigacage, IOAccelerator). Heap-vs-footprint
  gap is the first discriminator: small heap + large footprint ⇒ off-heap/native
  (JIT code, pg buffers), not JS objects. File-watchers cost ~0 MB.
- **`IOAccelerator` dirty memory is NOT GPU work** — it's JSC's rwx JIT/bytecode
  code region on Apple Silicon. Scales with distinct JS modules compiled (idle
  ~13 MB, full backend ~600–860 MB), **bounded** (plateaus, code-GC evicts). JIT
  flags don't shrink it. Treat ~600–860 MB as a per-backend baseline, not a leak.
  See `research/2026-06-18-global-backend-gpu-ioaccelerator-memory.md`.
→ [`plugins/debug/plugins/heap-snapshot/CLAUDE.md`](../../../plugins/debug/plugins/heap-snapshot/CLAUDE.md)

### Render churn — a subtree re-renders in a loop
The always-on DOM detector (`reports/render-loop`) flags THAT/WHERE a subtree
thrashes; the on-demand **React fiber-commit profiler** names the INITIATING
component + hook (esp. `useSyncExternalStore`, where `useResource`/`useQuery`
land), splits mount vs update, and ranks remounts with the structural cause
(element-type flip, key-change). OFF by default. Open **Debug → Render
Profiler**, or headless `./singularity run plugins/debug/plugins/render-profiler/e2e/render-profile.ts --url … --seconds 8`; the
report dumps to `logs/render-profiler.jsonl`; API `window.__reactRenderProfiler`.
→ [`plugins/debug/plugins/render-profiler/CLAUDE.md`](../../../plugins/debug/plugins/render-profiler/CLAUDE.md)

### Slow first paint — cold page load, request → first paint
- **Debug → Boot Profile** — the browser boot as a Gantt from the `boot-trace`
  store: `navigation` (0→TTFB), `scripts` (module eval + plugin load +
  createRoot), `main-thread` (Long Tasks ≥50 ms), `assets`/`resources` (wait vs
  work), `paint` (FP/FCP/first commit) + a boot-cost strip (JS shipped, chunk
  count, biggest chunk). Current tab, ephemeral; **Reload & re-measure**.
- **Bundle size** — `VITE_ANALYZE=1 bunx vite build` (in `web-core`) writes
  `web/dist.stats.html`, a treemap of every chunk. Caveat: never lump a
  partially-lazy heavy lib (react-icons, shiki, markdown) into one `manualChunks`
  group — it unions lazy code onto boot (715 KB → 2.4 MB gzip, once).
- **Server boot phases** — the **Profiling** Gantt shows boot phases + per-phase
  phys_footprint deltas. Caveat: onReady* plugins run under `Promise.all` so
  per-plugin deltas overlap (directional only); phase-boundary checkpoints are
  authoritative.
→ [`plugins/debug/plugins/boot-profile/CLAUDE.md`](../../../plugins/debug/plugins/boot-profile/CLAUDE.md) · [`plugins/framework/plugins/web-core/CLAUDE.md`](../../../plugins/framework/plugins/web-core/CLAUDE.md) (Bundle) · [`plugins/debug/plugins/profiling/CLAUDE.md`](../../../plugins/debug/plugins/profiling/CLAUDE.md)

### Jobs / queue stuck
`get_queue_health` (MCP) or **Debug → Queue** — inspect the jobs queue, events
emission log, and active triggers; dead / backlogged / slot-hog jobs also file
reports (STEP 0). → [`plugins/debug/plugins/queue/CLAUDE.md`](../../../plugins/debug/plugins/queue/CLAUDE.md)

## Cross-cutting tools (reach for these inside any branch)
- **Logs** — per-worktree `~/.singularity/worktrees/<wt>/logs/<channel>.jsonl`
  (survives restarts). `clientLog(channel, line)` to emit; `tail`/`cat` to read.
  → [`plugins/debug/plugins/logs/CLAUDE.md`](../../../plugins/debug/plugins/logs/CLAUDE.md)
- **Query DB** — `query_db` MCP, read-only SQL (`database` for another worktree /
  `"singularity"` for main). → [`plugins/database/plugins/query/CLAUDE.md`](../../../plugins/database/plugins/query/CLAUDE.md)
- **Claude CLI calls** — every `claude --print` with prompt / output / source /
  duration. → [`plugins/debug/plugins/claude-cli-calls/CLAUDE.md`](../../../plugins/debug/plugins/claude-cli-calls/CLAUDE.md)
- **Verify in the real app** — scripted Playwright (`plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts`): clicks,
  before/after shots, control state. Prefer over blind static shots.

## The front-door invariant
Every durable failure signal should land in **Reports** or on the **Timeline**.
If you had to discover one by hand — a stall, a wedge, a never-ready boot that
alerted nowhere — that is the bug behind the bug: file it (`add_task`) so the
signal gets ingested, not just this incident patched.
