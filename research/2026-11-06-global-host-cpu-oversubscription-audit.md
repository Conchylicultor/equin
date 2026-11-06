# Host CPU "oversubscription": grant-coverage audit and what the load average actually measures

Task: task-1793967902 (part of the responsiveness audit, supervisor task-1793965642-94fdhj).
Related: build-speed track task-1793964742-k0g8vg (not touched here).

## Question

On main, 2026-11-04 22:30 → 2026-11-05 04:30 UTC, `health-host.jsonl` showed load
average 25–146 on 18 CPUs (15-min bucket max 172 at 03:00), memory compressor
15–23 GB, up to ~196k decompressions/s. Downstream: main-thread freezes, live-state
wedges, worktree boots of 60–100 s killed at the gateway's readiness deadline. The
hypothesis was that heavy work (build / check / boot / test / e2e) is not
admitted against the machine's capacity.

## Finding 1 — the heavy ops are admitted; at the peak they were queued

Grant coverage, read from the code:

| work | admitted by | where |
| --- | --- | --- |
| `build` (deploy and hermetic, `release` through it) | ONE `cpu` grant, `max = B`, held from right after `.build.lock` to the verdict (stages 1–3, format, checks subprocess, deploy, health probe) | `withBuildAdmission`, build `app-artifacts.ts` |
| `check` | `cpu` grant via `withDirectOp`, `max = B`; nested checks spend the parent's grant | `check/cli/run.ts` |
| `test` | `cpu` grant via `withDirectOp`, `max = B` | `test/cli/run.ts` |
| `push` | push mutex + interactive `cpu` grant for the whole critical section | `push/cli/run.ts` |
| e2e scripts, agent browser | `e2e` pool (size 2) | `run/cli/run.ts`, `mcp/browser/bin/host-drives.ts` |
| supervised jobs (deps install, …) | background `cpu` grant, `max = 1` | `supervised-job/server/internal/admit.ts` |
| worktree prepare | `worktree-prepare` pool (4) | `infra/worktree` |
| heavy children inside an op | `grant.run` (type-check workers, vite, layout suite) | `spawn-worker.ts`, `app-artifacts.ts:1174`, `layout-harness` |
| gateway backend boots | **not admitted** (deploy restarts run inside the build's grant; lazy boots from traffic do not) | `gateway/worktree.go` |
| `regen-generated` / `normalize-generated` (post-rewrite hook), non-e2e `./equin run`, bootstrap `ensureDeps` | **not admitted** | CLI |

The op log for the peak (02:50–03:12 UTC) shows the admission working:
the six background builds (`wcaj1p`, `wqbbot`, `31n5jb`, `zkz07d`, `oudhj4`,
`tvs963`) and the checks/tests behind them waited **3–30 min** for their
`host-grant` (e.g. 381 s, 403 s, 533 s, 986 s, 1,846 s), and at most the
background lane's 6 slots were held at once. Two builds also waited 94 s on the
duress valve. So the box was not overrun by *unadmitted* ops.

The un-admitted rows are small by measurement:

- Gateway spawns over the 7-h window: 371 (`backend spawned`), 132 of them hot
  restarts a build requested (inside its grant). A quiet import is 1.5 s median
  (Finding 3), so even 240 traffic boots is minutes of CPU over 7 h — boots are the
  **victims** of the window, not its load. Gating them on the `cpu` grant would
  queue a page load behind 30-min builds; not done.
- The post-rewrite normalize pass is marker-gated (a no-op unless a merge driver
  fired) — not measured as a contributor.

## Finding 2 — on macOS the load average is not CPU demand

Measured 2026-11-06 ~12:30 UTC with `top -l` and a `node:os` `cpus()` delta:

| load avg (1m) | CPU busy |
| --- | --- |
| 32 | 47–53 % (≈ 50 % idle) |
| 30 | 52 % |
| 22.5 | 51 % |
| 19.5 | 45 % |

Load 30 on 18 cores with half the CPU idle. macOS counts every runnable thread,
including darwinbg-throttled ones (an agent session and every traffic-started
backend run darwinbg) and threads blocked on page-ins from the compressor. The
sentinel already stopped tripping duress on the load ratio for this reason
(research/2026-10-28-global-duress-trip-on-real-trouble.md). So "load 146" is
not proof of 8× CPU oversubscription. **And the host never recorded CPU
utilization**, so the window cannot be re-read as CPU demand: the only CPU-ish
series was the load average.

What the window does prove is **memory** pressure: compressor 15–23 GB and
98k–196k decompressions/s. Each decompression is a synchronous page fault on the
faulting thread — that, plus darwinbg throttling, is what turns a 1.5 s import
into 64 s (Finding 3).

### Landed: CPU busy in the host sample

`health-monitor`'s host sampler now records `cpuBusyPct` (user + nice + sys + irq
over all cores since the previous 10 s tick, from `os.cpus()` deltas — no spawn),
optional in `HostSampleSchema`, charted as **CPU busy (%)** in Debug → Health.
Oversubscription is now a reading: busy ≈ 100 with load ≫ cores. High load with
idle CPU is throttling or memory stalls.

## Finding 3 — boot import cost is spread, the slowdown is the host

From 674 full 25-wave boots in every worktree's `boot-journal.jsonl`:

- time to `after-import`: p10 1.2 s, median 2.6 s, p75 9.3 s, p90 36 s, p95 67 s, p99 84 s, max 160 s;
- quiet boots (< 2.5 s, n = 297) median 1.46 s; contended (> 40 s, n = 65) median 64 s — **~44×**;
- the slowdown is uniform: every wave slows 20–98×, wave shares barely move. No plugin
  dominates (per-plugin quiet max 130–230 ms: `infra/jobs#machine`,
  `sonata/sources/musicxml`, `allow-monitor#machine`, `host-fs/image`);
- static closure of all 657 server/machine barrels: 5,215 repo modules, 18.2 MB; a kernel of
  6 barrels (`database`, `infra/jobs`, `network/live`, `config_v2`, `infra/endpoints`,
  `infra/entities`) closes over 469 modules; 1,887 modules belong to exactly one barrel.
  28 npm packages are reached; no TypeScript / Playwright.

The ~14 s "quiet" figure in the task was one cold-cache first boot (13.9 s on
2026-11-04); later main boots are 1–2 s.

### On-demand server plugin loading — design only

Viable but not a small change, and it would not by itself fix the 44× multiplier.

- The loader is already lazy-shaped: `server.generated.ts` gives each plugin a
  `loader: () => import(…)` + `dependsOn`; waves in `server-core/core/boot-stages.ts:197-310`.
- Blockers: imperative `register` tokens (124 of 555 server barrels — MCP tools, jobs,
  runtime defines fill global registries before `onReady`); `collectContributions`
  needs every contributor loaded; `httpRoutes` (112 plugins) installed before the
  ready barrier; 39 `onReady` + 3 `onReadyBlocking` hooks; the preload-declare assert
  over live resources.
- Shape: the build emits a per-plugin manifest (routes, job ids, resource ids, MCP tool
  names, contribution kinds, has-hooks). Eager set = kernel + plugins with boot hooks;
  the rest import on first route / subscription / job tick / MCP call (their
  `dependsOn` closure first). Contribution consumers read the manifest. Requires
  `register` to become declarative data.
- Estimate (unvalidated): eager set of 150–200 barrels → 60–80 % fewer modules →
  quiet import ~1.4 s → ~0.4 s; contended ~64 s → < 15 s.

The higher-leverage fix for boots is the multiplier itself: a traffic-started
boot runs darwinbg (fixed in part 2026-11-05 by `followGatewayBootTier`, which
lifts a boot on the gateway's word) under compressor thrash.

## Finding 4 — the grant is greedy, not leaky

Observed 2026-11-06 12:35 UTC: one `./equin test plugins/network/plugins/live`
held **all six** background `cpu` slots (its acquire is elastic with
`max = B`; every slot file held by its workers), while five other tests, a check and
a build queued behind it. `check`, `test`, `push` and `build` all ask for `max = B`.
This is the opposite of oversubscription: one small op can idle the lane while
everything else waits. Whether a direct op should size `max` from its own fan-out
(how many test files / checks it selected) is a follow-up, not changed here (it
moves every op's wait profile and wants its own measurement).

## Before/after

- Before: the host recorded load average only; no CPU utilization at any time.
- After: every 10 s host sample carries `cpuBusyPct`; the window can be split into
  CPU saturation vs throttled/stalled threads the next time it happens.
- One build, measured 2026-11-06 12:34–12:39 UTC (this task's own `./equin build`,
  process tree's CPU time sampled every 5 s, host `top` every ~10 s):
  - queued 106 s for its grant (behind the greedy test of Finding 4), then held
    5–6 background `cpu` slots for 2.5 min;
  - its whole process tree used **0.59 cores on average, 2.6 at peak**;
  - over the same minutes the host went from load 17.5 to **60.9** while CPU busy
    stayed **44–62 %**, and `top` reported 5 processes running at load 60.

  A (mostly cached) build holds ~6 units while using ~1 core: the grant, as sized
  today, over-reserves rather than under-reserves.

## Follow-ups

1. Attribute host CPU/memory by owner continuously (backends, agent CLIs, ops, Chrome,
   Postgres) — `sentinel/machine-usage` does this on card open only; persisting a
   coarse bucket breakdown alongside the host sample makes every spike attributable.
2. Memory is the binding resource in the window (compressor 15–23 GB): the `B = 9`
   quantum models the mean worker, not the cold 5.3 GB tail
   (`host-admission/core/internal/budget.ts`), and nothing admits the ~20 agent CLIs
   (7.8 GB measured) or idle backends against RAM.
3. Size a direct op's `max` from its own fan-out (Finding 4).
4. On-demand server plugin loading (design above), after the boot multiplier.
