# A check pass runs a bounded number of checks at once

**Date:** 2026-09-02
**Category:** global (checks core + the `check` CLI command + the progress log)
**Status:** implemented 2026-09-02 — with one reversal, recorded under *Outcome* below

## Outcome (measured, and it contradicts this plan's proposal)

The plan proposed shipping a default width of one-per-core. **The matrix said
no, and the shipped default is unbounded.** Same tree, `--no-cache`, sequential:

| width | wall | Σ reported durations | inflation |
| --- | --- | --- | --- |
| 1 | 602s | 601s | 1.0× |
| 4 | 284s | 931s | 1.5× |
| 18 | 337s | 4 969s | 8.3× |
| 32 | 300s | 9 097s | 15× |
| 100 (unbounded) | 196s | 13 817s | 23× |

Wall clock improves monotonically with width — bounding to one-per-core costs
~1.7× — while a run's self-reported durations degrade 23×. So the gate is an
**instrument**, not a policy: narrowing by default would tax every run for a
fleet-level benefit nothing has measured. The knob ships; the default does not
change behaviour.

The true suite cost is **601s**, and it is one check:

```
  409.8s   68%  type-check
   41.5s   75%  active-data:document-chip-has-server-token
   13.8s   77%  plugin-boundaries
    ...
     83s  100%  (remaining 90 checks)
  58 of 100 checks cost under 1s.  30 under 100ms.
```

**Only width 1 is trustworthy.** At width 4 the same suite ranks
`table-defs-in-schema-glob` second at 131.8s; serially it is 5.8s — a 23× error,
and `plugin-refs-resolve` (ranked third at width 4) is not in the serial top ten.
A merely narrower run still reorders the table. Any future cost claim must cite a
width-1 run.

This sharpens the out-of-scope note on input-keyed caching below: the prize is
not "the expensive checks", it is **`type-check` and essentially nothing else**,
and `type-check` already sets `inputKeyed` — so the work is raising its hit rate,
not adopting the flag anywhere new.

**Still open, and it is the original motivation:** whether an unbounded pass (~100
processes, ~180 concurrent git subprocesses) is what makes *other* agents' builds
queue. A single-run matrix cannot answer it; that needs fleet wait-times measured
with the bound on and off. That experiment is the thing that would justify
changing the default.

---

**Original plan follows.**

## Context

`runChecks()` launches every selected check simultaneously:

```ts
results = await Promise.all(selected.map(async (check) => { … }))   // runner.ts:532
```

There is no bound. On this box that means ~100 checks start together, and the
consequences are measured, not theoretical.

**From `~/.singularity/check-progress.jsonl` (100 full runs, ~9.9k check-ends):**

- 99 checks start within 1.2–3.1 seconds of each other, every run.
- **442 hours of per-check duration compressed into 11 hours of wall clock.**
  Apparent parallelism 15–64×, on an 18-core box whose background CPU lane is 6 slots.
- In the *fastest* uncached runs (67–70s wall, near-idle host, 88 uncached checks)
  **not one check finishes under 11.3s**, and the median is ~24s. A check that
  asserts block prefixes are unique does not cost twelve seconds.
- Twelve unrelated checks share the same duration to within a few seconds —
  `no-plugin-workspace-deps` 261s, `plugin-refs-resolve` 260s,
  `config-origins-in-sync` 260s, `config-stable-list-ids` 260s,
  `plugins-doc-in-sync` 259s, and eight more. That number is the wave's own
  duration, not any check's cost.

The last point is the one that matters most. **Every per-check timing in the
ledger today is contention, not cost.** Any attempt to optimise "the slow checks",
or to decide which checks most deserve input-keyed caching, is currently aimed at
noise. Bounding the fan-out is what makes the numbers mean something, and that is
the primary reason to do it first — the throughput win is secondary.

Each check also spawns its own subprocesses: `readCandidates` (`grep-code.ts:194`)
does one `git grep -l` plus one batched `git cat-file --batch` per call, with no
sharing between checks. ~90 checks doing that at once is ~180 concurrent git
processes walking one repo, which is the most likely source of the 11s floor.

**Intended outcome:** a check pass runs at a declared width; a recorded per-check
duration is work rather than queueing; and the width is set from measurement
rather than from argument.

## Design

### One gate, separate from the grant

Add a bounded gate around the per-check body using **`createSemaphore`**
(`@plugins/packages/plugins/semaphore/core`) — already the repo's canonical
in-process bound, already what `grantOfUnits` is built from
(`host-admission/server/internal/grant.ts:36`), and importable from `core`.

```ts
const gate = createSemaphore(width);
results = await Promise.all(
  selected.map((check) =>
    gate.run(
      () => runWithProgress(check),
      (waitMs) => { queued.set(check.id, waitMs); },
    ),
  ),
);
```

**The gate must NOT be `options.grant`.** Two independent reasons:

1. **It deadlocks.** One `Grant` object is shared by every check
   (`runner.ts:411`), and it wraps a single `createSemaphore(units)` with no
   reentrancy. `type-check` calls `ctx.grant.run()` per worker from inside its own
   `run()` (`type-check/check/index.ts:317`), and `layout-geometry` does
   `ctx.grant.run(() => browserPool.run(fn))`. With `units === 1` — which
   `acquireShare` may legitimately return under load — an outer wrap holds the
   only slot while the check's own body waits for a slot that only its own
   completion can free. `host-read-pool` already hit this exact bug class and
   fixed it with an ALS reentrancy guard; the simpler answer here is not to
   nest at all.
2. **It over-serialises.** `grant.units` is a CPU budget (~6 in the background
   lane). Most checks are spawn/IO-bound, not CPU-bound — one or two `git`
   spawns and a handful of file reads. They can legitimately run far wider than
   `B` CPU-bound workers.

So: the grant keeps bounding a check's *heavy children*; the new gate bounds *how
many checks run at once*. Different resources, different gates, no nesting.

### Capture `wallStart` inside the gate

This is the part that is easy to get wrong and would defeat the whole exercise.
`wallStart` is captured today at `.map` time (`runner.ts:534`). If it stays there,
queue time lands inside `durationMs` and we reproduce exactly the measurement
corruption we are removing. Capture it **after** the gate grants, and record the
queue wait separately via `createSemaphore`'s `onWait` hook.

Thread the wait through as a new trailing argument on
`progress.checkEnded(checkId, durationMs, ok, cached, queuedMs)` and into the
`end` record. `onCheckDone` (→ the op profiler's `recordStep`) keeps receiving the
post-gate `wallStart`, so its `performance.now()` contract is unchanged.

### `--status` must still name a hang

`progress.checkStarted` stays *inside* the gate, so "started" continues to mean
"running". Queued checks are then neither started nor ended — which would make a
bounded run look emptier than it is.

No new record is needed: `resolved()` already publishes the full `selected` list,
so `readCheckProgress()` can derive `queued = selected − started − ended` and
`printProgress` (`cli/plugins/check/cli/run.ts:120`) can report
`N running, M queued, K settled`. Deriving it keeps the two facts from
disagreeing.

Note the one real behaviour change: under a bound, a wedged check eventually
stalls the run behind it, where today its peers still drain. The progress log
already names the culprit and the heartbeat still fires, and `--jobs 1` becomes a
first-class debugging tool for exactly this.

### The width

`--jobs <n>` on the `check` command, plus `SINGULARITY_CHECK_JOBS`. The env var is
load-bearing, not a convenience: `runCheckSubprocess` spawns the child with
`...process.env` (`check-subprocess.ts:147`), so an env knob reaches build's and
push's check passes with no threading, exactly as `SINGULARITY_CHECK_NO_CACHE`
already does (`runner.ts:329`).

Ship with `width = min(selected.length, hostCpuCeiling())` — one per core, 18 here
— as a starting default that is ~5× less thrash than today while staying far above
the CPU budget. **Then replace it with the measured answer** (below). `--jobs 1`
must be a supported value: a serial run is the only way to obtain a true per-check
cost table.

## Files

- `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts` — the gate, the
  `wallStart` move, `RunChecksOptions.jobs`.
- `plugins/framework/plugins/tooling/plugins/checks/core/progress-log.ts` —
  `queuedMs` on `checkEnded` and the `end` record; derive `queued` in
  `readCheckProgress()`.
- `plugins/framework/plugins/cli/plugins/check/cli/index.ts` — the `--jobs` flag.
- `plugins/framework/plugins/cli/plugins/check/cli/run.ts` — pass it through;
  extend `printProgress` to report the queued set.
- `plugins/framework/plugins/tooling/plugins/checks/CLAUDE.md` — document the
  bound and why it is not the grant.

Reuse `createSemaphore` rather than hand-rolling. Note there are already two
private copies of a worker-pool loop — `mapConcurrent`
(`type-check/check/index.ts:135`) and `pMap`
(`debug/plugins/worktree-cleanup/server/internal/handle-list.ts:21`). Do **not**
add a third; the `Promise.all` + semaphore shape above needs neither, and
consolidating those two is a separate cleanup.

## Measurement (this is deliverable, not optional)

On a quiet host, same tree, `--no-cache`, one run per width:

| width | what it answers |
| --- | --- |
| 1 | the true serial cost of the suite, and the first honest per-check cost table |
| 4 | is the knee below the CPU budget? |
| 18 | the proposed default |
| 32 | does extra width still buy anything? |
| unbounded | today's baseline, for comparison |

Record per run: wall clock, Σ per-check `durationMs`, Σ `queuedMs`, peak RSS of
the process tree, and the per-check table at width 1.

Set the shipped default from the curve. Two outcomes are both acceptable and must
be reported honestly: the bound may improve wall time, or it may cost some wall
time and buy trustworthy measurements plus a host that stops driving itself into
duress. What must not happen is shipping a width nobody measured.

The width-1 per-check table is also the direct input to the input-keyed cache
work — it is the first data that can say which checks are actually worth caching.

## Verification

1. `./equin check --jobs 4` — passes; `check-progress.jsonl` `end` records
   carry non-zero `queuedMs` for later checks and ~0 for the first four.
2. `./equin check --jobs 1` — passes; every `queuedMs` is the sum of its
   predecessors' work; durations no longer cluster.
3. During a bounded run, `./equin check --status` from a second shell
   reports a running set of exactly `width` and a non-empty queued set.
4. `./equin check type-check --jobs 1` — the deadlock case. Must complete;
   `type-check`'s own `grant.run()` fan-out is unaffected by the gate.
5. `./equin check layout-geometry --jobs 1` on a cold marker — must launch
   Chromium and complete, confirming `grant.run(() => browserPool.run(…))` still
   nests cleanly outside the gate.
6. `SINGULARITY_CHECK_JOBS=8 ./equin build` — the spawned check subprocess
   inherits the width; confirm from its progress records.
7. Existing suites: `./equin test plugins/framework/plugins/tooling/plugins/checks`.

## Out of scope

- **Sharing git greps between checks.** ~7 pattern checks each spawn their own
  `git grep -l` + `cat-file --batch` over the same tree with no dedup;
  `createInflight` (`packages/plugins/inflight`) is the natural primitive. Likely
  a large independent win — file separately once the width-1 table says how large.
- **Input-keyed cache adoption.** Only 11 of ~100 checks set `inputKeyed`; the
  rest key on the whole working tree, giving a 6.5% hit rate and a guaranteed
  miss on every push (the rebase always moves the tree). Stage 3 of
  `research/2026-07-17-global-input-keyed-check-cache.md`.
- **Host-pool reservations.** Filed as its own task —
  `reservedCpuCost()` subtracts every pool's declared peak unconditionally, so
  idle pools tax every build forever.
- **FIFO on the push mutex.** `host-semaphore/CLAUDE.md` documents that barging is
  unchanged; push-mutex waits average 11.7m on a single ~45%-utilised slot.
