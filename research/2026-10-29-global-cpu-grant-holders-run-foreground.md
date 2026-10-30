# CPU-grant holders run in the foreground

Task: task-1793289675-9umc8x. Track: "Track: build and push speed" (wiki block-e5afc5b1-15f2-4614-a49a-c7b4e6fe1851), items [Queue] hold-and-wait and [Admission] "measure after on a busy day".

## Context

The duress fix (595901e7a0, 2026-10-29 00:03Z) was expected to move agents' waiting from the duress gate to the CPU host grant. The task: measure where background-build wall time goes now, broken down into gate, CPU grant, worker slot and work, then fix the largest cost. The task suggests hold-and-wait (a build holding its CPU share while parked on the type-check worker slot) if that is still the largest.

## Measurement (2026-10-29, 00:00–16:30Z, a busy day)

### 1. Where background build wall time goes

From `build-wait.ts` plus the check transcripts (`~/.equin/worktrees/<wt>/check-<runId>.log`, whose `slot wait` line is the only record of worker-slot waits).

| Day | Builds | Wall | Duress gate | CPU grant | Worker slot |
| --- | --- | --- | --- | --- | --- |
| 10-28 (before the fix) | 154 | 4,596 min | 2,892 min (63 %) | 197 min (4 %) | 39 min (builds) + 26 min (checks) |
| 10-29 (after the fix) | 45 | 592 min | 25 min (4 %) | 187 min (32 %) | 4 min (builds) + 1 min (checks) |

- **The duress fix worked.** The gate went from 63 % of build wall time to 4 %.
- **The CPU grant is now the queue, and not only for builds.** Background waits at the grant on 10-29, by op kind:

  | Op kind | Ops | Grant wait | Op wall |
  | --- | --- | --- | --- |
  | build | 49 | 186 min | 533 min |
  | check | 60 | 249 min | 344 min |
  | test | 85 | 212 min | 306 min |

  About 650 waiter-minutes in total.
- **Hold-and-wait on the worker slot is no longer the large cost.** Every finished build and check today waited 5 min in total for the worker slot. The type-check now holds its slot for a median of about 25 s, against 500 s on 10-16. It still happens: a live `./equin check` was seen holding a CPU slot at 0 % CPU while pending only on type-check. But it is about 1 % of the grant wait.

### 2. Why the grant queue is long

- **Holder-time is mostly background builds.** Today's grant holds summed to 255 min for background builds (median hold 4.3 min, up to 15 min), 105 for e2e, 95 for tests and 80 for checks.
- **The window is full of slow holders, not of busy ones.**
  - lsof on `locks/cpu/slot-*.lock` at 16:25Z showed all 6 background slots held: 3 agent builds held 1, 1 and 3 slots, and one check held 1.
  - Those 3 builds' process trees used 0.2–3 cores and 0.7–5.4 GB, sampled every 8–10 s. A slot is 1 core / 3.6 GB.
  - The host was 35–47 % CPU idle (`top`) with 9 waiters queued.
- **Every holder runs at darwinbg.**
  - Background-lane grant holders and their children are `pri 4`, the same tier as about 575 other demoted processes on the 12 E-cores.
  - The `cpu` pool is `holder: "inherit"`. Only an interactive grant lifts its holder (`withForegroundPriority` in `withPoolGrant`).
  - The same build steps on the same day, main (foreground) against agent (darwinbg), medians:

    | Step | Main | Agent | Slower |
    | --- | --- | --- | --- |
    | viteBuild | 23.5 s | 126 s | 5.4× |
    | artifacts:build | 1.0 s | 16.9 s | 17× |
    | browser-hosts | 1.2 s | 19.0 s | 16× |
    | css | 1.4 s | 12.4 s | 8.6× |
    | generateMigration | 7.7 s | 32.9 s | 4.2× |

  - The build's in-process checks show the same thing. `endpoints:no-raw-json-handlers` took 63.8 s, of which 54.5 s was an event-loop stall.
  - This is the bug already fixed twice:
    - the push lock's normalize, 109 s → 13 s once its holder ran in the foreground;
    - the type-check-worker slot holder, 500 s → 73 s (research/2026-10-16-global-scarce-slot-holders-run-foreground.md).
  - It was left in place for `cpu` on the grounds that "lifting it would lift every agent". That is not so: the grant bounds the lifted set to at most 6 background slots' holders. The agents' own sessions, their servers and ungranted codegen stay darwinbg.

**Rate × cost:** wait ≈ holders × hold time ÷ slots. The rate (builds, checks and tests per hour) is the fleet's. The cost per hold is 4–17× inflated by the holder's scheduling tier. That inflation is the largest lever found, and it applies to every kind of holder. Right-sizing shares is the next lever, recorded as follow-up 1.

## Fix

**Invariant, extended to the `cpu` pool:** whoever holds a CPU grant does its granted work in the foreground, in both lanes. The CPU grant is now a pool others queue on, so it falls under the same rule as `push` and `type-check-worker` (host-admission CLAUDE.md, "A scarce slot's holder runs in the foreground").

1. **`plugins/infra/plugins/host/plugins/host-admission/server/internal/grant.ts`, `withPoolGrant`:** run `fn` under `withForegroundPriority` for every lane, not only `interactive`.
   - Children spawned inside the grant inherit the lift. Work before the grant (codegen) and after it stays at the caller's tier.
   - Rewrite the `cpu` pool's comment and the `withHostGrant` doc. The bound is now the grant window itself (background ≤ 6 slots, B from RAM), which is why lifting cannot reach the whole fleet.
   - Decide whether `cpuPool` becomes `holder: "foreground"`. The `ForegroundSlot` spawn-scoped lift is for `pool.run` holders, while a grant lifts its whole holder process because a build's heavy section is the process's only work. Keep whichever spelling makes "a grant holder demoted" inexpressible, and update the pool table in host-admission `CLAUDE.md`.
   - Check the users of a lane-dependent lift for anything that assumed background holders stay demoted:
     - `core/internal/grant.ts` docs;
     - `op-runtime/cli/direct-op.ts` (direct `check` / `test`);
     - `infra/jobs/supervised-job` admit;
     - `database/admin`.
2. **Tests:** extend host-admission's existing `withPoolGrant` tests, which run against a share they control. A background grant runs `fn` lifted, and the tier is restored after `fn`, including when it throws.
3. **Ruler: `plugins/debug/plugins/profiling/plugins/op-log/scripts/build-wait.ts`.**
   - Add the **worker slot** and **work** columns the task asks for. Join each build to its check transcript by run id (= build id); work = wall − gate − grant − worker slot.
   - Add a per-op-kind grant-wait table (build / check / test / e2e), because the grant queue is shared.
   - The transcript join is the only source today. Moving the worker-slot wait into the op log as its own `WAIT_KINDS` entry needs the nested check child to reach its op's profiler, which it cannot. That is filed as follow-up 2, not done here.

Out of scope here: the hold-and-wait fix itself (measured at about 1 % of grant wait, follow-up 2), and the git tree-hash floor (owned by the build pipeline track's [Snapshot] item).

## Benchmark (before / after)

**A. Controlled.** One worktree, the same tree, the same one-line body edit toggled before each run, so each run is a real warm build. Run `./equin build` 3× with the fix and 3× without, interleaved, toggling the patch with `git apply` / `git apply -R`. All runs are at real fleet load, with the load recorded per run. For each run, record:
- grant hold (heavy-section wall);
- the step durations above, from build-progress;
- the checks' wall time and stall total, from check-progress;
- the CPU-s of the process tree.

**B. Main is not hurt.** For the whole of A, a foreground probe hits main's `/api/search` every 250 ms (a `curl` loop), plus main's event-loop p99 from its health log. Compare p50 and p95 during lifted runs, during darwinbg runs and in idle windows, as on 10-16. If main's p95 degrades materially, stop and report before landing.

**C. Fleet (after push, on the next busy day).** `build-wait.ts`, comparing 10-29 with the first busy day after the push:
- grant wait share;
- per-kind grant wait;
- build wall p50 / p90.

This needs a push and a busy day, so it goes to the next task.

Write A and B, and the 10-29 measurement above, to the track page: Current status, the [Queue] and [Admission] items, and a new investigation section.

## Verification

- `./equin test plugins/infra/plugins/host/plugins/host-admission`.
- `./equin check`.
- `./equin build`, then `ps -o pri` on the build's children during its heavy section: 31+ (foreground), not 4.
- Benchmark A and B as above.

## Follow-ups (file only the next main task, per the track instructions)

1. **Right-size the grant.** A share is fixed at acquisition and held for the whole heavy section, whatever the holder uses. On 10-29 holders used 0.2–3 cores and 0.7–5.4 GB against 1–3 slots (3.6 GB each). The fix is an elastic grant, shrinking while idle. The token inheritance through `EQUIN_HOST_GRANT` and the deadlock shapes in research/2026-07-11-global-fleet-memory-admission-duress-valve.md make it a design of its own.
2. **Hold-and-wait.** Release, or never hold, the CPU share while parked on `type-check-worker`, and log that wait in the op log. Revisit if C shows it grew.
3. **Ungranted codegen.** About 80 s of codegen before the grant runs darwinbg (4–5× slower than main's). That is the build pipeline track's concern; note it there.

## Result (2026-10-30)

Benchmark A and B: this worktree, the same tree, a one-line comment in `fullscreen/web/components/fullscreen-toggle.tsx` per run, the `grant.ts` change toggled with `git apply` between runs, interleaved B A B A B A after one discarded warm-up. Fleet load during the runs (1-min) was 15–28. Medians of 3:

| | Before (holder darwinbg) | After (holder foreground) |
| --- | --- | --- |
| Grant hold (heavy section) | 231 s (378, 231, 217) | 60 s (60, 54, 81) |
| Build wall | 349 s | 164 s |
| viteBuild | 116 s | 27 s |
| artifacts:browser-hosts | 30.9 s | 1.6 s |
| artifacts:detect | 60.5 s | 20.4 s |
| Control: generateMigration (before the grant) | 25 s | 29 s |
| Main `/api/search` p50 / p95 during holds | 59 / 69 ms | 44 / 62 ms |

In idle windows, main's p50 / p95 was 58 / 76 ms. The probe was `curl` every 250 ms from the agent's own darwinbg shell, so it adds its own scheduling noise to every arm alike.

Main did not degrade. The codegen before the grant stays darwinbg in both arms and stayed level, so the gain comes from the lift, not from load changing between runs.

Benchmark C (fleet-wide, on a busy day after the push) remains. `build-wait.ts` now reports the worker slot, the work and the per-kind grant wait. Over the full day of 10-29, background ops waited at the CPU grant for this share of their wall time: builds 27 %, checks 70 %, tests 69 %. Builds' worker-slot waits came to 28 min.
