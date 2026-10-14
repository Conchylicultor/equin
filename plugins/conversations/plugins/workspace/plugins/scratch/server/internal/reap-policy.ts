/** How long a scratch workspace outlives its task, and an orphan its last write. */
export const SCRATCH_REAP_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** What the reaper knows about one directory under the scratch root. */
export interface ScratchDirFacts {
  /** The directory's name — the attempt id it was created for. */
  attemptId: string;
  /** The directory's own mtime (it moves whenever an entry is added or removed). */
  mtimeMs: number;
  /**
   * The attempt row, or `null` when this database has none. A scratch attempt
   * launched from a worktree backend lives in THAT backend's database, so a
   * missing row alone never proves the directory is abandoned.
   */
  attempt: null | {
    /** The user has not finished with the attempt (a conversation not done). */
    retained: boolean;
    /** When the attempt finished (its conversations closed), if it did. */
    finishedAt: Date | null;
    /** When its task was dropped, if it was. */
    taskDroppedAt: Date | null;
  };
}

export type ScratchReapDecision =
  { reap: true; reason: string } | { reap: false };

/**
 * Whether to delete one scratch workspace. Pure.
 *
 * - With an attempt row: once its task has been dropped, or the attempt
 *   finished (every conversation closed), for longer than the grace.
 * - With none: once the directory itself has been untouched for longer than
 *   the grace (see {@link ScratchDirFacts.attempt}).
 */
export function decideScratchReap(
  facts: ScratchDirFacts,
  nowMs: number,
  graceMs: number = SCRATCH_REAP_GRACE_MS,
): ScratchReapDecision {
  const { attempt } = facts;
  if (!attempt) {
    return nowMs - facts.mtimeMs > graceMs
      ? { reap: true, reason: "no attempt row, untouched past the grace" }
      : { reap: false };
  }
  const ends = [
    attempt.taskDroppedAt,
    attempt.retained ? null : attempt.finishedAt,
  ].filter((d): d is Date => d !== null);
  if (ends.length === 0) return { reap: false };
  const endedAt = Math.min(...ends.map((d) => d.getTime()));
  return nowMs - endedAt > graceMs
    ? {
        reap: true,
        reason: attempt.taskDroppedAt
          ? "task dropped past the grace"
          : "attempt finished past the grace",
      }
    : { reap: false };
}
