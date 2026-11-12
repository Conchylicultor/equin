import type {
  TestOutcome,
  TestStatus,
} from "@plugins/debug/plugins/tests/core";

/** What the selection reads of one file's status row. */
export interface BatchCandidate {
  path: string;
  status: TestStatus;
  lastOutcome: TestOutcome | null;
  lastRanAt: Date | null;
  /** The last known run's duration; `null` for a file never run. */
  durationMs: number | null;
}

/** A batch stops once its files' last-known durations add up to this... */
export const IDLE_BATCH_BUDGET_MS = 60_000;
/** ...or at this many files. */
export const IDLE_BATCH_MAX_FILES = 25;
/** What a file with no known duration is counted as. */
export const UNKNOWN_DURATION_MS = 2_000;
/** A verdict on current code older than this is re-checked once nothing else is left. */
export const REVERIFY_AFTER_MS = 7 * 24 * 60 * 60_000;

const ranAt = (c: BatchCandidate): number => c.lastRanAt?.getTime() ?? 0;
const oldestFirst = (a: BatchCandidate, b: BatchCandidate): number =>
  ranAt(a) - ranAt(b) || a.path.localeCompare(b.path);

/**
 * The next files an idle run should take, most useful first:
 *
 * 1. stale and last failing — the likeliest to have been fixed (or to still
 *    be broken) on the current code;
 * 2. never run;
 * 3. stale, oldest run first;
 * 4. only when none of those is left: verdicts on the current code older than
 *    {@link REVERIFY_AFTER_MS}, oldest first — the sweep over the digest's
 *    blind spots (env, fixtures on disk, spawned processes).
 *
 * The batch stops at {@link IDLE_BATCH_MAX_FILES} files or once its
 * last-known durations reach {@link IDLE_BATCH_BUDGET_MS} (a file is taken
 * whole, so the first always is): a preempted batch loses little. Empty when
 * nothing is worth running.
 */
export function selectIdleBatch(
  candidates: readonly BatchCandidate[],
  now: number,
): string[] {
  const stale = candidates.filter((c) => c.status === "stale");
  const lastFailing = (c: BatchCandidate) =>
    c.lastOutcome !== null && c.lastOutcome !== "passed";
  const ordered = [
    ...stale.filter(lastFailing).sort(oldestFirst),
    ...candidates
      .filter((c) => c.status === "never")
      .sort((a, b) => a.path.localeCompare(b.path)),
    ...stale.filter((c) => !lastFailing(c)).sort(oldestFirst),
  ];
  const pool =
    ordered.length > 0
      ? ordered
      : candidates
          .filter(
            (c) =>
              c.status !== "stale" &&
              c.status !== "never" &&
              c.lastRanAt !== null &&
              now - c.lastRanAt.getTime() > REVERIFY_AFTER_MS,
          )
          .sort(oldestFirst);
  const batch: string[] = [];
  let budget = 0;
  for (const c of pool) {
    if (batch.length >= IDLE_BATCH_MAX_FILES || budget >= IDLE_BATCH_BUDGET_MS)
      break;
    batch.push(c.path);
    budget += c.durationMs ?? UNKNOWN_DURATION_MS;
  }
  return batch;
}
