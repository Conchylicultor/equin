import { normalizeMessage } from "@plugins/reports/core";
import type { DeadJobErrorStat } from "@plugins/infra/plugins/jobs/machine";
import { hash53 } from "@plugins/packages/plugins/string-hash/core";
import type { QueueDeadJobPayload } from "../../core";

/**
 * A dead job's CAUSE, as an identity: its last error with the tokens that vary
 * between occurrences of one failure (run ids, job ids, attempt numbers)
 * normalized away — the same normalization a crash's message identity uses.
 * Two deaths of one job share a cause exactly when this string is equal.
 *
 * Why a dead job is identified by its cause and not by its job alone: a job is
 * a place, not a failure. Keyed on the name, every new reason a job dies lands
 * on the report (and the task, and the triage) of the FIRST reason it ever
 * died, so a brand-new failure introduced by a recent commit raises no fresh
 * signal at all — 2026-11-04, `worktree.prepare` dying of an `ALTER DATABASE`
 * race, filed under a week-old report linked to an unrelated task.
 *
 * A death with no error at all has the empty cause: all such deaths of one
 * job are indistinguishable, and saying so is the honest answer.
 */
export function deadJobCause(lastError: string | null): string {
  return lastError === null
    ? ""
    : normalizeMessage(lastError, DEAD_JOB_CAUSE_MAX_CHARS);
}

// Wider than a one-line message's 200, because the cause often sits past
// them: a supervised child that recorded no error of its own is dead-lettered
// as `[supervised-job] <job>: run <uuid> exited 1 on attempt n/n: recorded no
// error; its transcript (<path>) ends:` followed by up to 2 KB of transcript —
// the prefix and path alone fill 200 characters, which would fold every such
// death of a job back onto one cause. The transcript's end of one crash is
// identical run to run (its stack), so the whole of it is a stable identity.
const DEAD_JOB_CAUSE_MAX_CHARS = 4000;

/**
 * The `queue-dead-job` report identity: the job AND the cause of its deaths.
 * The cause is hashed (cyrb53, base 36) rather than spelled in, because it is
 * up to 200 characters of error text and the report row already carries the
 * text itself (`data.lastError`). Rows filed before the cause was part of the
 * identity (`queue-dead-job:<jobName>`) keep their history; a recurrence lands
 * on a new, per-cause row.
 */
export function deadJobFingerprint(d: QueueDeadJobPayload): string {
  return `queue-dead-job:${d.jobName}:${hash53(deadJobCause(d.lastError)).toString(36)}`;
}

/**
 * Fold the queue's dead rows, grouped by their EXACT last error, into one group
 * per (jobName, cause): the exact text still carries per-occurrence ids, so
 * forty deaths of one cause arrive as forty groups and leave as one. Counts
 * add; attempt counters keep the worst; the error and sample job shown are
 * those of the first exact group — the newest, as `queryDeadJobsByError`
 * orders them — every one of which normalizes the same.
 */
export function foldDeadJobsByCause(
  rows: readonly DeadJobErrorStat[],
): DeadJobErrorStat[] {
  const groups = new Map<string, DeadJobErrorStat>();
  for (const row of rows) {
    const key = `${row.jobName}\0${deadJobCause(row.lastError)}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { ...row });
      continue;
    }
    group.deadCount += row.deadCount;
    group.attempts = Math.max(group.attempts, row.attempts);
    group.maxAttempts = Math.max(group.maxAttempts, row.maxAttempts);
  }
  return [...groups.values()];
}
