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
 * (`~/.singularity/worktrees/*​/check-*.log`, n ≈ 300, read 2026-09-17): mean
 * 7.2 GB, p50 7.0 GB, max 16.6 GB.
 *
 * The MEAN, matching what `PER_UNIT_BYTES` itself models — the fleet ceiling
 * has never carried tail headroom, and giving this one consumer a tail-sized
 * weight while every other holder is sized on its mean would ration the wrong
 * thing. See research/2026-09-18-global-type-check-one-program.md.
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
 */
export const TYPE_CHECK_BATCH_FILES = 2000;
