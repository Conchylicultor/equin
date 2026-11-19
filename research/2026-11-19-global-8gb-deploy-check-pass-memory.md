# An 8 GB host deploys main: the check pass fits one memory unit

2026-11-19. Task: on a fresh 8 GB Linux install main never updates, because the
deploy's check pass is OOM-killed on every advance. Follows
`2026-11-18-global-linux-8gb-deploy-oom.md` (an OOM kill no longer takes the
gateway down), `2026-11-18-global-cold-check-pass-memory.md` (the type-check
worker no longer lints up front) and
`2026-11-18-global-type-check-batch-working-set.md` (a batch's memory is its own
working set; the "small-host profile" left as a decision).

## Why the earlier work did not cover it

- **bd82e3510d** made the kill safe (`OOMPolicy=continue`, `oom_score_adj` 800)
  and split the build's grant so checks and the frontend no longer overlap. It
  bounded nothing inside the check pass.
- **7e212163e6** removed the worker's up-front lint (2.7 → 0.6 GB idle). Its own
  VM run still died: the check process itself was killed in its first minute.
- **x0mclc / rpl28z** made Linux memory measured, so host admission's window is
  real. But admission counts **units** (3.6 GB quanta) and its window never
  drops below one unit — "one op always runs". An 8 GB host has a fleet
  budget `B = 1`: the build gets one unit, its checks get that unit. Inside
  the pass, nothing is admitted by memory:
  - every in-process check starts at once, in one process that keeps what
    they build (the "~5 GB of checks" is that process plus the type-check
    worker and its first batch, all on one unit);
  - the type-check worker declares a weight of 2 units (7 GB) and `Grant.run`
    clamps it to the 1 unit held — then runs the 7 GB profile anyway.

So "the parallelism is bounded by measured free memory" held only at the
granularity of whole ops; within the op, the one unit was spent ~2.5 times.

## Measured (fresh Tart Ubuntu 24.04 arm64, 4 CPU / 8 GB, no swap)

Install of main a970d4ccec (`install.sh --repo … --terminal`, 4 m 51 s), then
an empty commit on main. App running, one headless Firefox tab on it:
MemAvailable 4.7–4.9 GB before the deploy.

**Baseline deploy: killed at 53 s**, in its checks. At the kill (PSS):
check process 3.6 GB (still growing), type-check worker 0.6, first batch 0.5
(just started), build orchestrator 0.7, backend 0.54, Firefox ~0.7.
`dmesg`: `Killed process (bun) anon-rss:3717628kB … oom_score_adj:800`.

**Serial pass** (`--jobs 1`, same tree, 16 GB clone, per-check sampling): the
check process still reaches **3.15 GB before type-check and 3.44 GB during it**.
Width is not the lever; the process keeps what finished checks built. The
biggest steps: `migrations-in-sync` (+1.1 GB, transient), `css:*` (+1.0 GB, kept),
`theme-bridge-reads`, `sql-writes:fit`, `plugin-boundaries` (~0.7 GB each).
Re-run once the plugin records are warm (every check but type-check and
layout, unbounded, `--no-cache`): **1.7 GB peak, 26 s**. The 3+ GB is the cold
pass building host-wide records, once per install (or after a wide change).

**Type-check alone**, fresh 8 GB clones, cold:

| profile | outcome | batches | batch peak | worker peak | tree (PSS, sampled) | CPU |
| --- | --- | --- | --- | --- | --- | --- |
| K 2000, paced 4 GB (today) | **OOM-killed** (batch 5.2 GB anon) | 9 | 5.7 GB¹ | 4.7 GB¹ | — | 971 s¹ |
| K 500, paced 1.5 GB | passes, min MemAvailable 1.86 GB | 36 | 3.3 GB | 3.8 GB | ~3.9 GB | 1373 s |

¹ measured on the 16 GB clone, where it completes.

Heap pacing alone does not shrink the check process (unbounded, warm records:
1.70 GB default vs 1.57 GB paced at 1.5 GB) — consistent with the Mac result
(live data, not GC slack).

## What changed

1. **A grant unit is honoured by the type-check worker**
   (`type-check/core/worker-weight.ts`). Two memory profiles,
   `TYPE_CHECK_FULL_PROFILE` (K 2000, 4 GB pace) and
   `TYPE_CHECK_ONE_UNIT_PROFILE` (K 500, 1.5 GB pace); `typeCheckProfileFor(units)`
   picks from the units the share ACTUALLY holds, inside `grant.run`
   (`spawnTypeCheckWorker`). The clamp used to admit the 7 GB worker on a
   3.6 GB share; now a clamped worker shrinks to the share. A small (light)
   run keeps the full pace (≤ 100 sources, already ≤ 3.4 GB). The profile is
   printed on the admission line and recorded with the worker's memory, and
   `type-check:worker-weight-measured` judges the full weight on full-profile
   runs only. `pacedHeapEnv(env, ramBytes)` takes the pace.
2. **On a one-unit grant the heavy checks run first, alone**
   (`checks/core/heavy-first.ts`, wired in `runner.ts`). A check that spends
   `ctx.grant` declares it (`Check.heavyChildren: { what }`): type-check,
   layout-geometry, `live:read-misuse-diagnostics`. Any other check's
   `grant.run` throws, naming it. With one unit, the declaring checks run
   first, one at a time; every other check waits for them. Heavy FIRST: the
   in-process checks' memory stays resident after they finish, so a heavy
   child started after them would run beside it. A wider grant keeps one
   phase (every check at once).
3. **A deploy killed for memory says so** (build-status `out-of-memory`,
   `BUILD_EXIT_OUT_OF_MEMORY` 71): a build whose failure is only killed steps,
   one a SIGKILL, while the host's OOM-kill counter rose (Linux `/proc/vmstat`
   `oom_kill`, read at the build's start and end) ends `out-of-memory`, rings a
   user-facing bell ("equin couldn't update") and draws an "Update not
   deployed" health-report row. Still a no-verdict end: convergence retries it.

4. **A build the kernel kills WHOLE says so too.** With another app holding
   memory, the OOM killer takes the build process itself (the biggest
   kill-first process), which records nothing. The convergence run reads the
   same counter around its child and closes the row `out-of-memory` instead of
   `killed` (`deadBuildExitCode`, `framework/cli/build`'s `failure-end.ts`).

## Proof (fresh 8 GB VMs cloned from the post-install snapshot, then deleted)

| VM | advance | outcome |
| --- | --- | --- |
| app running | #1 the fix (cold pass) | **deployed**, 17.5 min; min MemAvailable 0.86 GB (a batch at 3.1 GB) |
| app running | #2 empty commit | **deployed**, 37 s |
| app + Firefox tab (5.2 GB available) | #1 the fix | out of memory: a 2.9 GB batch, then the cold rest-phase check process (4.7 GB anon); the build ended `out-of-memory` (exit 71) — the bell was the old serving backend's "Build failed" |
| app + Firefox tab | #2 empty commit | **deployed**, 13 min (the killed attempt had warmed part of the records) |
| app running, 5.3 GB held by another process | #3 (fix v1) | the build process itself killed: `killed` (137), developer-only bell — the gap item 4 closes |
| same, fix v2 serving | #4 | `out-of-memory` (71), user bell "equin couldn't update" |

## Cost, and where it is paid

- One-unit hosts (8 GB; or any host whose measured window gives the check pass
  one unit — on this 64 GB Mac, agent check passes are often granted 1 unit)
  pay +41 % CPU on a batched (cold or wide) type-check, and the pass's wall
  time becomes heavy + rest instead of their max. An incremental type-check
  (no batches) pays only the pace on its program.
- A two-unit-or-more grant is unchanged.

## Not done

- The check process's cold peak itself (3.2 GB serial, 3.7 GB RSS unbounded)
  — what the cold record producers allocate (task-1795031104-e6529p, and the
  Performance tree's task-1795051277-00ygdj). With heavy-first it no longer
  overlaps a batch, so an 8 GB host with the app running fits; with a browser
  tab open too, the first cold attempt still runs out of memory (now told to
  the user) and a later attempt deploys.
- systemd-oomd (Ubuntu desktop) kills a whole cgroup without moving the
  kernel's `oom_kill` counter: such a kill stays `killed`.
- A cold pass is still minutes on 4 CPUs (task-1795006239-dae69p).
