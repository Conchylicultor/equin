/**
 * A keyed job's settle window (`dedup: { key, settle }`): the debounce that
 * turns a burst of enqueues for one key into one run after the burst stops.
 *
 * Every enqueue of a key moves its PENDING row's due time to `now + quietMs` —
 * but never past `maxWaitMs` after that row was first queued, so a key enqueued
 * without pause (an agent editing a page for minutes) still runs every
 * `maxWaitMs` instead of never. A row already RUNNING releases its key (graphile
 * detaches it; the in-process queue never collapses onto a running row), so an
 * enqueue landing mid-run gets a fresh row: nothing that happened after a run
 * started is folded into it.
 *
 * Both fields are required: the ceiling is a choice, not a default to forget.
 */
export interface SettleSpec {
  /** How long the key must go without an enqueue before its run. */
  readonly quietMs: number;
  /** The most a pending row's run is pushed back from when it was first queued. */
  readonly maxWaitMs: number;
}

/**
 * The due time of a settled enqueue at `now`, given when the pending row it
 * collapses onto was created (`null`: there is none, so it starts a fresh
 * window). The one spelling of the rule, shared by every queue provider.
 */
export function settledRunAt(
  settle: SettleSpec,
  now: Date,
  pendingCreatedAt: Date | null,
): Date {
  const quiet = now.getTime() + settle.quietMs;
  if (pendingCreatedAt === null) return new Date(quiet);
  return new Date(
    Math.max(
      now.getTime(),
      Math.min(quiet, pendingCreatedAt.getTime() + settle.maxWaitMs),
    ),
  );
}

/** Refuse a settle window that cannot mean what it says — at define time. */
export function assertSettleSpec(jobName: string, settle: SettleSpec): void {
  if (
    !(settle.quietMs > 0) ||
    !(settle.maxWaitMs >= settle.quietMs) ||
    !Number.isFinite(settle.maxWaitMs)
  ) {
    throw new Error(
      `[jobs] ${jobName}: settle needs 0 < quietMs <= maxWaitMs (finite), got ${JSON.stringify(settle)}`,
    );
  }
}
