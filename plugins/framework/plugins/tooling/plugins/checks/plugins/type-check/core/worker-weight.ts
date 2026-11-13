// How much of the host one type-check worker is worth, declared where the cost
// is MEASURED rather than where the budget is defined.
//
// `host-admission` sizes the elastic fleet in units of `PER_UNIT_BYTES` (3.6e9
// — the fleet's mean peak resident set). That quantum was calibrated when this
// check spawned SEVEN small-to-medium workers per run; it now spawns one worker
// that builds the whole repo's program, which is a different size of thing. So
// the worker declares its own weight, the grant clamps it, and nothing in
// host-admission has to know that this consumer exists.

import { PER_UNIT_BYTES } from "@plugins/infra/plugins/host/plugins/host-admission/core";

/**
 * One heavy worker's peak PHYSICAL FOOTPRINT: the worker process's own peak
 * plus its batch processes' peak at once — the run the `type-check-worker`
 * pool admits for a global change or a typed rule edit (every file, in
 * batches of K). An upper bound: the two need not coincide (sampled every 30 s
 * by main's owner sampler, the worker sat at 0.5–1.0 GB while a batch ran,
 * below its own 1.5–2.9 GB peak).
 *
 * MEASURED 2026-11-13, the first day the cost lines print the footprint, over
 * every heavy batched run on this host (n = 8, five worktrees: typed rule
 * edits, global `.d.ts` edits, whole-tree rebases): worker 1.5–2.9 GB, batches
 * 4.4–5.3 GB at once, tree peak p50 6.8 GB, mean 7.0 GB, max 8.1 GB. The
 * MEAN, matching what `PER_UNIT_BYTES` models — the fleet ceiling carries no
 * tail headroom (research/2026-09-18-global-type-check-one-program.md).
 *
 * Every run since appends its measurement to the host's worker memory log
 * (`../check/worker-memory.ts`), and `type-check:worker-weight-measured`
 * (main's hourly host audit) fails when this value sits more than 20 % from
 * the last 14 days' mean, or the mean is another number of units — so it is
 * held to the record, not re-read by hand.
 *
 * History: 7.2e9 was the mean getrusage maxRSS of the old `test` worker
 * (n ≈ 300, 2026-09-17), re-checked heap-paced at 5.3 GB maxRSS for one cold
 * run (2026-11-08). maxRSS also counts freed allocator pages and library text
 * (1.8 vs 1.15 GB on one worker,
 * research/2026-11-12-global-type-check-worker-memory-split.md); the footprint
 * mean landed 3 % under it, inside the same 2 units.
 *
 * A LIGHT run (`type-check-light`, programs of ≤ 100 sources) is far smaller —
 * 0.2–3.4 GB, n = 14 the same day — but spends the same units: the weight is
 * charged inside the holder's own grant, never against the fleet window.
 */
export const TYPE_CHECK_WORKER_PEAK_BYTES = 7.0e9;

/**
 * The grant units one worker spends — the peak above expressed in the host's
 * own quantum, rounded UP so a worker is never admitted for less than it takes.
 *
 * DERIVED, never a literal: a retune of `PER_UNIT_BYTES` reflows into this
 * weight automatically, so the two can never come to disagree about how big a
 * unit is. On this host it is `ceil(7.0 / 3.6) = 2`.
 */
export const TYPE_CHECK_WORKER_UNITS = Math.ceil(
  TYPE_CHECK_WORKER_PEAK_BYTES / PER_UNIT_BYTES,
);

/**
 * K: the most source files one program holds. A set larger than this — a cold
 * run, a global change, a wide rebase — is checked in dependency-ordered
 * batches of at most K (an import cycle larger is one batch of its own), each
 * in its own process, one at a time, so a process's memory is bounded by K,
 * not by the repo. Every program re-pays the environment (lib, `@types`, the
 * npm types the repo resolves: ~10–15 CPU-s), so a few batches, not many.
 * Measured cold, lint included (one sample each, loaded host): one program
 * 620 CPU-s / 22.1 GB; K 6000 370 / 17.4; 4000 495 / 14.8; 3000 404 / 12.8;
 * 2000 (7 batches) 442 / 10.3 — the whole program's memory pressure costs
 * more than the batches re-pay
 * (research/2026-10-23-global-type-check-bounded-batches.md).
 *
 * Re-measured heap-paced (2026-11-08, cold, lint included): K 2000 (8 batches)
 * 473 CPU-s / 5.3 GB; K 3000 (6) 460 / 6.1. Pacing moved both peaks down but
 * not the trade: a larger K saves ~3 % CPU (inside run-to-run noise) for
 * +15 % peak, and memory is what the host runs out of, so K stays
 * (research/2026-11-08-global-type-check-bun-heap-pacing.md).
 *
 * Every number above is getrusage maxRSS. Read as physical footprint
 * (2026-11-13, n = 8 heavy runs at K 2000, 9 batches each): a batch peaks at
 * 4.4–5.3 GB, against 5.3 GB maxRSS for the same shape. The trade is a ratio
 * between two K's measured the same way, so the unit does not move it; K was
 * not re-benchmarked at other sizes in footprint.
 */
export const TYPE_CHECK_BATCH_FILES = 2000;

/**
 * L: the most source files (checked, or held to be linted) one program of a
 * SMALL run holds. A run is first admitted as small (host-admission's
 * `type-check-light` pool) unless it plainly is not (more lint files than L,
 * or a mode beside the keyed check); its worker builds every program of at
 * most L sources in its own process and refuses a larger one, answering
 * over-budget, and the run is re-admitted through the `type-check-worker` pool.
 *
 * Measured over 150 check transcripts (2026-11-02..05), by the largest program
 * of each run: ≤ 100 sources covered 94 runs, peak RSS ≤ 3.9 GB (p90 1.9),
 * ≤ 34 CPU-s; the next step (≤ 400) adds 10 runs but reaches 79 CPU-s and
 * 4.9 GB. Those 94 runs had waited 9,476 s of the heavy pool's 13,073 s.
 *
 * Those peaks are maxRSS. Re-read as physical footprint (2026-11-13, n = 14
 * light runs, 8 of them with work): 0.2–3.4 GB, p50 of those 2.2 GB — the bound sits
 * on the same side of every number above (CPU and slot wait are unchanged by
 * the unit), so L stays. Two heavy un-batched runs of 357 and 513 sources
 * measured 3.2 and 2.5 GB: too few to move L on.
 */
export const TYPE_CHECK_LIGHT_SOURCES = 100;
