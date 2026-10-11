import type { LaunchCandidate } from "./registry";

/**
 * How many agents a launch-kind automation may start now: its concurrency
 * minus the tasks still holding a slot, never below zero (a person lowering
 * the concurrency below what runs stops nothing — it only waits).
 */
export function freeSlots(concurrency: number, occupied: number): number {
  return Math.max(0, concurrency - occupied);
}

/**
 * How many more a launch-kind automation may launch in its current batch: its
 * `maxLaunches` minus what it launched since it was turned on, never below
 * zero.
 */
export function batchRemaining(
  maxLaunches: number,
  launchedInBatch: number,
): number {
  return Math.max(0, maxLaunches - launchedInBatch);
}

/**
 * The candidates to launch now: the first `free` of them, in the order the
 * automation ranked them, that a person APPROVED — skipping any not in
 * `approved` (never launched, whatever its rank), any in `taken` (a task an
 * automation already filed or launched, or one someone armed) and any repeated
 * id.
 */
export function selectLaunches(
  candidates: readonly LaunchCandidate[],
  approved: ReadonlySet<string>,
  taken: ReadonlySet<string>,
  free: number,
): LaunchCandidate[] {
  const picked: LaunchCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (picked.length >= free) break;
    if (!approved.has(candidate.taskId)) continue;
    if (taken.has(candidate.taskId) || seen.has(candidate.taskId)) continue;
    seen.add(candidate.taskId);
    picked.push(candidate);
  }
  return picked;
}
