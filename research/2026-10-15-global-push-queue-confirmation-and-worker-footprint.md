# Push queue under real load and the type-check worker's real footprint

Track: "Track: build and push speed" (wiki block-e5afc5b1-15f2-4614-a49a-c7b4e6fe1851).

## Context

Three fixes are on main: Phase 1 (push holder's type-check in the foreground, laned
pool of 2, 8f89aee0c4, landed 02:59Z), the lint cache keyed per rule group (659e925337,
14:50Z), and the whole push lock hold under one interactive grant (e8286efbbe, 18:10Z).
The exit criteria are still unverified: push lock hold median < 8 min, push wait p90
< 20 min at ≥ 3 pushes/h, never more than 2 type-check workers alive in any hour.
Separately, worker memory cannot be read from the logs (maxRSS undercounts under memory
pressure), and `bun --smol` rests on one cold run.

### Phase 0: what today's op log already says (re-measured, 2026-10-15 03:00Z → 18:11Z)

28 pushes (23 success, 5 failed_rebase), about 1.6/h. That is **below the ≥ 3/h load the
criteria are stated at**, so today cannot confirm the queue under load.

| | median | p90 | max |
| --- | --- | --- | --- |
| lock hold | 109 s | 484 s | 1362 s |
| push wait | 0 s | 2693 s | 4642 s |
| normalize | 53 s | 109 s | 255 s |
| checks | 55 s | 208 s | 1281 s |

The outliers are explained by the fixes, not left over by them:
- The 970 s and 1281 s checks (03:09Z and 03:24Z, and their 45–77 min waits) came from
  branches that were not rebased onto Phase 1. A push runs the push code loaded from its
  own branch, so they ran the old background-tier checks. *Consistent, not proven*: the
  check ledger for that window has already rotated away.
- The 798 s checks (11:03Z) and the 208 s checks (11:59Z): the rebase brought in a
  workspace-only `bun.lock` edit (plus an exemption edit at 11:03Z), which was a global
  lint trigger and forced a full re-lint before 659e925337. Same caveat: the ledger is gone.
- The first push under e8286efbbe (18:10Z): normalize 13.4 s (was a median of 53 s), hold 43 s.

So the "checks p90 ~1400 s" seen after Phase 1 traces to pushes that ran before a fix took
effect. That attribution has to be confirmed on new pushes, and the evidence keeps vanishing.

**Two gaps block a verdict, whatever the load:**
1. `check-progress.jsonl` rotates by size (3 × 2 MB ≈ 6 h today), so a push's per-check
   breakdown is gone by the time anyone reads it.
2. Nothing records worker concurrency over time. The pool's slots are bare flock files.
   `hostOccupancy()` is a point-in-time probe, and the per-check cost line has no timestamps.
   "≤ 2 workers in any hour" is enforced by construction: both spawn sites, build
   `app-artifacts.ts` and the check, go through `spawnTypeCheckWorker` → pool. But it
   cannot be *shown*.

## Plan

### 1. Make the confirmation readable (small, generic)

**1a. Host-pool hold ledger.** In `infra/plugins/host/plugins/host-admission/server/internal/pool.ts`,
every `defineHostPool` acquire/release appends `{t, pool, slot, lane, pid, worktree, op, event}` to a
new `host-pool` file sink. This is generic for every pool, not type-check specific, so
"max holders alive per hour" is answerable for any pool, and the memory-admission item
later reads the same record. Release is written on the normal path. A holder that dies
is visible as a missing release, and the reader closes it at the holder's pid exit (or,
failing that, the next acquire of the same slot).

**1b. Age-based retention for analysis ledgers.** Add a `maxAgeMs` option to `defineFileSink`
(`infra/plugins/file-sink/core/internal/file-sink.ts`): on rotation, rotated files younger than it
are kept, with `maxBytes × keep` still the hard cap. Give `check-progress`, `host-pool` and the
op log 7 days. Check the cap against today's rate first (≈ 2 MB per 2 h for check-progress →
~170 MB/week; if too large, slim the heartbeat records rather than shortening the window).

**1c. `push_queue_sim.py fit` on the v2 op log.** Pull the simulator from the incident page. Make
`fit` read v2 events (`summary.steps`, `waits[]` with `host-grant`), split pushes by the code
they ran (marker: a `host-grant` wait before `rebase` = e8286efbbe or later), and report the
exit criteria directly: hold median, wait p90, pushes/h, and max type-check-worker holders per
hour from 1a. Keep it on the wiki page next to its incident, where it lives today, not in the repo.

### 2. Memory: measure the real footprint

**2a. Log phys_footprint, not maxRSS.** Reuse `procMemory` (`framework/plugins/server-core/core/phys-footprint.ts`).
Extend it to read `RUSAGE_INFO_V4` and expose `lifetimeMaxPhysFootprintBytes`, the kernel's own
peak, which is exactly the number maxRSS was failing to be. The offset is verified against
`<sys/resource.h>` and a unit test that allocates a known buffer. The worker (`type-check/shared/worker.ts`)
reads it at each phase boundary (program built → diagnostics → emit → lint) together with
`bun:jsc` `heapStats()` (live heap, object count). It returns these in its JSON result. `workerCostLine`
(`type-check/check/index.ts`) prints `peak footprint X GB` plus a one-line phase breakdown, and drops maxRSS.
The `end` record for type-check needs no new field. The cost line is already durable in the
per-check log.

**2b. `--smol`, decided by measurement.** Interleaved, one worker at a time, on the same tree:
3 cold runs default vs 3 cold `--smol`, plus 1 cold + full lint each. Cold means fresh tsbuildinfo
and lint store in a scratch copy, as in the lint-cache benchmark. Measure with the 2a ruler, and record
host load. **Adopt rule:** peak footprint −20 % or more on every cold pair, with CPU within +5 %
→ add `"--smol"` to the inner argv in `spawn-worker.ts:~103` (inside `backgroundArgv`). Otherwise
record the negative result and stop. Warm runs: one pair, to confirm the earlier "no effect".

**2c.** Checker type counts during lint stay a backlog item. 2a's per-phase live heap answers the
"checker cache vs per-file ESTree" question well enough to decide whether it is needed.

### 3. Track page

Fill in the measured before/after: the Phase 0 table above, and the 2a/2b results; tick
the overview items that are done. Then file the next main task: run the 1c fit over the
first window at ≥ 3 pushes/h, and give the verdict on Phase 1, the lint cache and the
foreground hold. It carries the page id.

## Verification

- `./singularity test` on host-admission (ledger acquire/release incl. crash path), file-sink
  (age retention), server-core phys-footprint (V4 offset).
- `./singularity check type-check` in this worktree: the cost line shows peak footprint and
  phases, and `host-pool.jsonl` shows one acquire/release pair.
- `./singularity build` passes. The 2b table is produced by real runs, and the raw lines are kept in the
  page's sub-section.
- Footprint sanity: one run read with an external `footprint <pid>` sampled mid-run must match the
  logged peak within ~5 %.
