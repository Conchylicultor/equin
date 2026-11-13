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
 * One repo-program worker's peak resident set.
 *
 * The union program is the old `test` program plus ~2.5 % more files, so the
 * `test` worker's measured peak is the right estimate for it. `7.2e9` is that
 * worker's MEAN peak RSS over every check transcript on this host
 * (`~/.equin/worktrees/*​/check-*.log`, n ≈ 300, read 2026-09-17): mean
 * 7.2 GB, p50 7.0 GB, max 16.6 GB.
 *
 * The MEAN, matching what `PER_UNIT_BYTES` itself models — the fleet ceiling
 * has never carried tail headroom, and giving this one consumer a tail-sized
 * weight while every other holder is sized on its mean would ration the wrong
 * thing. See research/2026-09-18-global-type-check-one-program.md.
 *
 * Re-checked 2026-11-08 once workers and batches run heap-paced
 * (`packages/heap-pacing`): a cold whole-tree run — the heaviest a worker
 * does — peaked at 5.3 GB (10.4 GB unpaced, same tree). Any peak in
 * (3.6, 7.2] GB is 2 units, so the weight is unchanged; the mean is to be
 * re-read from transcripts once paced runs dominate them
 * (research/2026-11-08-global-type-check-bun-heap-pacing.md).
 *
 * MEASURED AS maxRSS (getrusage), which over-states the physical footprint
 * the kernel charges — 1.8 vs 1.15 GB on one worker, ~0.65 GB of freed
 * allocator pages and library text
 * (research/2026-11-12-global-type-check-worker-memory-split.md). The cost
 * line prints the peak footprint since 2026-11-13; this mean is to be
 * re-read from those lines, not adjusted by a guessed offset.
 */
export const TYPE_CHECK_WORKER_PEAK_BYTES = 7.2e9;

/**
 * The grant units one worker spends — the peak above expressed in the host's
 * own quantum, rounded UP so a worker is never admitted for less than it takes.
 *
 * DERIVED, never a literal: a retune of `PER_UNIT_BYTES` reflows into this
 * weight automatically, so the two can never come to disagree about how big a
 * unit is. On this host it is `ceil(7.2 / 3.6) = 2`.
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
 */
export const TYPE_CHECK_LIGHT_SOURCES = 100;
