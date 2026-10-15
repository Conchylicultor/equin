# Push queue: run the push holder's type-check at foreground priority, and cap type-check workers host-wide

Status: plan, not built. Wiki: Mental model → Performances → Build, check,… → "Push queue — 2026-10-14 incident" (findings + simulator).

## Context

On 2026-10-14 agents waited up to **109 min** for the push mutex (`push-mutex` waits in `~/.singularity/op-log.jsonl`). Nothing was wedged: the queue was FIFO in practice (granted order = requested order), but each push **held** the mutex 21–53 min instead of ~5, and 3.2 pushes/h arrived.

Inside the lock every step is seconds except `normalize` (2–3 min) and `checks` (21–51 min), and `checks` is `type-check`:

| push run | warm base matched | worker CPU | maxRSS | checks wall |
|---|---|---|---|---|
| u81bxu 66b187e2 | 11220/11248 | 1291 s | 9.6 GB | 1474 s |
| v2wn57 0eb20903 | 11254/11259 | 2211 s | 6.7 GB | 3074 s |
| uo9ck7 a690c04d | 11253/11262 | 718 s | 2.6 GB | 1360 s |
| 8013f7 97959e28 | 11255/11266 | 945 s | 14.1 GB | 1263 s |
| quiet-host warm runs | — | 29–162 s | 3–10 GB | 29–196 s |

The programs were 99.9 % warm, so the *work* was quiet-run sized — yet each burned 718–2211 CPU-s (more than a fully cold run, ~616 CPU-s). wall/CPU was only 1.1–1.9: the workers were not mostly queued for CPU, their **work inflated** — 2–4 concurrent type-check workers (each 7–14 GB) on a host in continuous memory duress (decompressions 347k/s, swap 5.9/7 GB), all of them pinned to the 12 E-cores (see below).

Two structural causes, found by reading the code:

1. **(C) The lock holder runs at background priority.** `workerBackground()` (`plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/index.ts:66`) demotes the worker when the branch is not `main` — a push runs on the agent's branch, so the one check every queued push waits on is darwinbg (E-cores, throttled IO). Worse, the whole agent session is darwinbg (`conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts:741` prefixes `claude` with `backgroundPrefix()`), and darwinbg is inherited, so *not* demoting is not enough: the worker must be **promoted**. `build/cli/run.ts:1240` has the same branch-name gate. The push already holds an `interactive` lane grant (`push/cli/run.ts:253`) and `SINGULARITY_LANE` reaches the check subprocess — the right signal exists; nothing reads it for priority. The 2026-07-08 A/B that judged demotion harmless (`research/perfs/2026-07-08-host-saturation-agent-checks-starve-main.md:190-205`) was measured on a quiet host only.
2. **(D) Nothing bounds concurrent type-check workers.** The worker asks `ctx.grant.run(…, { units: 2 })`, but `spendOf` clamps the weight to the holder's own share (`infra/host/plugins/host-admission/server/internal/grant.ts:50-57`), and `acquireShare` hands every holder ≥ 1 slot. So up to B = 9 holders can each run a 7–14 GB worker; the 2-unit memory weight is never enforced across holders. Admission never reads live memory (`hostOccupancy` only counts flock slots); the duress valve gates only background builds, not checks or workers.

### Counterfactual (simulator, `push_queue_sim.py` on the wiki page)

Discrete-event model fitted to the day: pushes 3.2/h, other type-checks 6/h, 245 s alone, 150 s of in-lock non-check work, 19 % failed checks, per-worker speed `n^-α` (fitted α ≈ 1.3–1.4 from wall vs concurrency; the incident behaved like α ≈ 1.5). Mean push latency:

| policy | α=1.2 | α=1.5 (incident) |
|---|---|---|
| A today | 26 m | 119 m |
| B full pre-check outside lock + incremental re-check (rejected) | 77 m | 131 m |
| C push holder's worker at foreground | 11 m | 37 m |
| E laned cap, 2 slots, background may use 1 | 13 m | 18 m |
| **C + E** | **9 m** | **9 m** |

C + E also cuts background type-check latency (16 → 7 m at α=1.2; 116 → 8 m at α=1.5): serializing background workers costs nothing once the thrash is gone. B is rejected: the agent's own `build` already is the pre-check, main always moved under contention so the re-check never skips, and it adds a full worker to the very concurrency that inflates every worker.

## Design

One idea for both halves: **the lane is the priority.** A grant already carries the lane (interactive = push, main build, main check; background = agent build, agent check). Make it a first-class field and derive both the CPU priority and the type-check slot from it — the branch-name gates disappear (rung 1: no branch spelling left to get wrong).

### Step 0 — instrument (no behaviour change)

- Extend the existing `type-check worker repo: cpu …s, maxRSS …` line (`type-check/check/index.ts:265-270`) with `lane=<lane> priority=<background|foreground> waited=<ms for type-check slot>` and split CPU into user/sys (spawnCaptured's `readResourceUsage` — check whether Bun's rusage exposes `cpuTime.user`/`.system`; sys time is the memory-pressure signal).
- Gate experiment for C, run before writing C: from an agent-session shell, spawn a child, `taskpolicy -B -p <childpid>`, and confirm with `taskpolicy -p`/the child's own `getpriority(PRIO_DARWIN_PROCESS)` that it left darwinbg. If the agent sandbox refuses it, C promotes through the gateway instead (it already does `taskpolicy -B -p` for backends: `gateway/worktree.go:759-786`).

### Step 1 — `lane` on `Grant`

- `infra/host/plugins/host-admission/core/internal/grant.ts:23-44`: add `readonly lane: Lane` to `Grant`.
- `server/internal/grant.ts`: `grantOfUnits(units, lane)` already takes it — store it; `inheritedGrant()` reads it back from `SINGULARITY_LANE` (`HOST_LANE_ENV`), required (throw when a grant is inherited without a lane — fail loudly, no default).

### Step 2 — (C) priority from the lane

- `packages/spawn-priority`: replace the boolean `background` spawn option with `priority: Lane` semantics — `background` → `taskpolicy -b` prefix (today), `interactive` → spawn then `taskpolicy -B -p <pid>` (or the gateway hop, per Step 0). One function owns the mapping; `spawnCaptured`/`spawnPassthrough` (`infra/spawn/core/internal/spawn-captured.ts:139`, `spawn-passthrough.ts:32`) take the lane.
- `type-check/check/index.ts`: delete `workerBackground()` and its git spawn; pass `ctx.grant.lane`.
- `build/cli/run.ts:1240`: `backgroundBuild = branch !== "main"` becomes the build's own lane (`laneFor(...)` already computed at :1227) — the second branch-name gate goes too.
- Guard rail kept: only interactive-lane holders are promoted, and the interactive lane is bounded (3 reserved slots; push is one-at-a-time by its mutex), so this cannot re-create the 2026-07-08 "agent fleet starves main" incident.

### Step 3 — (E) a laned `type-check-worker` host pool

- `infra/host/plugins/host-admission/core/internal/budget.ts:120-131` (`HOST_POOLS`): add `"type-check-worker"`, laned, `size = max(2, floor(hostRamCeiling / TYPE_CHECK_WORKER_PEAK_BYTES))`, `backgroundLimit = size - 1`. `TYPE_CHECK_WORKER_PEAK_BYTES` lives beside `TYPE_CHECK_WORKER_UNITS` in `type-check/core` (`core/worker-weight.ts`), re-measured from the maxRSS lines (p90 today ≈ 14 GB → size 2 on this 64 GB host). Pools are cardinality caps — they withhold nothing from B (budget.ts:107-114).
- Declare it like `browser-fetch` (`infra/safe-fetch/plugins/browser-fetch/server/internal/pool.ts:16-31`) via `defineHostPool`; `host-pools-declared` and `data-dirs` pick it up.
- Acquire it with `{ lane: ctx.grant.lane }` around the worker spawn in both spawn sites: `type-check/check/index.ts:248` and the build's fast path `build/cli/internal/app-artifacts.ts:702-714`. It is a leaf (never held across another acquire) → deadlock-free. The wait lands as its own op-log wait (`type-check-slot`) via the pool's `onWaitStart` hooks, so the queue is visible instead of hiding in `checks`.
- Background holders share 1 slot; the interactive lane (push holder, main build/check) reaches the reserved one. The CPU-unit clamp stays (it is a CPU concern); memory is now bounded by the pool — update the comment at `type-check/check/index.ts:242-247` that documents the loophole.

### Step 4 — retention of the evidence

`check-progress.jsonl` rotated past this incident in < 1 day (oldest record 2026-10-14T17:13Z on the 15th), so the per-check data for the slow window is gone; only transcripts survived. File as a separate task (rotate by age, not only size), not part of this change.

## Critical files

- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/index.ts`, `…/type-check/core/worker-weight.ts`
- `plugins/infra/plugins/host/plugins/host-admission/{core,server}/internal/grant.ts`, `core/internal/budget.ts`
- `plugins/packages/plugins/spawn-priority/core/internal/background.ts`, `plugins/infra/plugins/spawn/core/internal/spawn-{captured,passthrough}.ts`
- `plugins/framework/plugins/cli/plugins/build/cli/run.ts`, `…/build/cli/internal/app-artifacts.ts`

## Verification

1. `./singularity test plugins/infra/plugins/host/plugins/host-admission plugins/packages/plugins/host-semaphore plugins/packages/plugins/spawn-priority` — new tests: an inherited grant carries its lane (and throws without one); a laned size-2 pool admits at most one background holder while the interactive lane still gets a slot.
2. Fleet replay: on an agent branch start two `./singularity check` runs and one `./singularity push` together. Expect: transcripts show the push worker `lane=interactive priority=foreground`, the second background worker `waited=` > 0 with its `type-check-slot` wait in the op log, and never more than 2 workers alive (`ps`).
3. One day of normal fleet use, then `python3 -I push_queue_sim.py fit --from … --to …` on the window and compare to the 2026-10-14 baseline. Exit criteria: push lock hold median < 8 min and push wait p90 < 20 min at ≥ 3 pushes/h; type-check worker CPU on a warm program < 300 CPU-s (vs 718–2211 s); no hour with > 2 type-check workers alive.

## Not in scope / remaining floor

Even at C + E the push floor is ~9 min (normalize 2–3 min + a warm type-check on a quiet host), against the wiki target of < 30 s. That gap is the in-lock normalize and type-check themselves (incremental cost of the delta main brought in), the next lever after this one.
