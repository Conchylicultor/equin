import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { deadlineMsFor, type HoldClass } from "../../core/hold";
import {
  jobDeadlineSink,
  type JobDeadlineEvent,
} from "../../server/internal/deadline-seam";
import { checkSlotFloor, clearForfeit, recordForfeit } from "./forfeit";
import { JobDeadlineExceededError } from "../../server/internal/deadline-error";

// THE INVARIANT OF THIS FILE: **there is no `Promise.race` here, and there must
// never be one.**
//
// Racing the handler against a deadline would let the wrapper RETURN while the
// handler is still running. That return releases the advisory lock, which is the
// only thing telling the stuck-lock sweeper this row still has an owner; the
// sweeper then reclaims the row, graphile re-dispatches it, and a possibly
// non-idempotent handler runs a second time alongside its own zombie. That is
// precisely the corruption the advisory-lock design exists to prevent — the same
// shape as the old age-based lease, which stole ~25 live jobs in 8 days.
//
// So the timers here abort a signal, announce, and write the slot off. Nothing
// returns early, no row is touched, no lock is released. The slot frees when,
// and only when, the handler actually settles.
//
// The write-off (forfeit.ts) is accounting, never recovery — and the one thing
// it can lead to is this PROCESS exiting, which is a different act entirely
// from taking a job away from a handler: at teardown Postgres drops every
// advisory lock at once, so the next boot's sweeper reclaims rows whose owner
// provably no longer exists. That is the only safe way slots come back.
//
// The abort is also the ONLY lever available. We cannot un-await a promise, so a
// handler that ignores `ctx.signal` keeps running — which is why the second timer
// exists: the point at which we say so out loud rather than assuming the first
// one worked.

/**
 * How long after the abort we wait before calling the run a zombie.
 *
 * It is a grace on the UNWIND, not a second budget: a handler that honours the
 * signal has to propagate the rejection out through whatever it was awaiting,
 * and 30 s is generous for that while still being short enough that a wedge is
 * named while an operator is still looking at it.
 */
const ZOMBIE_GRACE_MS = 30_000;

export interface ArmDeadlineArgs {
  jobName: string;
  jobId: string;
  attempt: number;
  hold: HoldClass;
  /** Which runner in the ladder dispatched this run (`floor` / `mid` / `wide`). */
  runnerId: string;
  /** This dispatch's controller — `ctx.signal`'s other half. */
  abort: AbortController;
}

/**
 * Arm this dispatch's deadline. Returns `disarm()`, which the caller MUST call
 * in a `finally` around the handler — that is what makes a handler that settles
 * in time cost nothing but one cleared timer.
 *
 * Call it INSIDE the `withJobLock` closure. The lock has to be held for the
 * handler's real lifetime including its overrun, and arming outside the closure
 * would start the clock during lock acquisition rather than during the run.
 */
export function armDeadline(args: ArmDeadlineArgs): () => void {
  const { jobName, jobId, attempt, hold, runnerId, abort } = args;
  const deadlineMs = deadlineMsFor(hold);
  const startedAt = Date.now();

  let zombieTimer: ReturnType<typeof setTimeout> | null = null;

  const deadlineTimer = setTimeout(() => {
    // The abort comes FIRST. Everything after it is announcement, and a
    // failure to announce must not delay the one action that can actually stop
    // the handler.
    abort.abort(
      new JobDeadlineExceededError(
        `[jobs] ${jobName} (job ${jobId}, attempt ${attempt}) exceeded its ${hold} deadline of ${deadlineMs} ms — giving up on this run`,
      ),
    );
    announce({
      phase: "exceeded",
      jobName,
      jobId,
      attempt,
      hold,
      deadlineMs,
      elapsedMs: Date.now() - startedAt,
      runnerId,
    });

    // The second timer. A handler that honours the signal settles well inside
    // this, `disarm()` clears it, and nothing more is said. A handler that
    // ignores it is still holding its slot and its advisory lock when this
    // fires, and that is a materially different fact from "it overran" — so it
    // gets its own arm rather than being folded into a retry of the first.
    //
    zombieTimer = setTimeout(() => {
      // Write the slot off BEFORE announcing. The accounting is what the floor
      // check reads, and it must be true before anything acts on it — including
      // the floor check at the bottom of this callback, which may end this
      // process. Announcing first would risk exiting with the pool's own
      // records disagreeing with the report explaining the exit.
      //
      // This reclaims NOTHING: no row is touched, no lock released, the handler
      // keeps running. See forfeit.ts — that is the property that keeps the
      // sweeper from ever reclaiming a row whose handler is still live.
      recordForfeit({ jobId, jobName, hold, runnerId, since: Date.now() });
      announce({
        phase: "zombie",
        jobName,
        jobId,
        attempt,
        hold,
        deadlineMs,
        elapsedMs: Date.now() - startedAt,
        runnerId,
      });
      // Last: whether the pool can still do its job with the slots that are
      // left. This is the one call in this file that can end the process, and
      // it is deliberately last so the zombie is recorded and reported first.
      checkSlotFloor();
    }, ZOMBIE_GRACE_MS);
  }, deadlineMs);

  // Idempotent: `disarm()` is called from a `finally` that can run after either
  // timer has already fired, and `clearTimeout` on an elapsed or already-cleared
  // handle is a no-op. Nulling the handles keeps that true even if a caller ever
  // calls it twice.
  return function disarm(): void {
    clearTimeout(deadlineTimer);
    if (zombieTimer !== null) {
      clearTimeout(zombieTimer);
      zombieTimer = null;
    }
    // A handler that settled AFTER being written off gives its slot back — the
    // one thing short of a restart that does. `clearForfeit` returns null on
    // the normal path (nothing was ever written off), so the announcement fires
    // only for a genuine recovery and never as noise on every completed job.
    if (clearForfeit(jobId) !== null) {
      announce({
        phase: "unforfeited",
        jobName,
        jobId,
        attempt,
        hold,
        deadlineMs,
        elapsedMs: Date.now() - startedAt,
        runnerId,
      });
    }
  };
}

// A deadline that fires silently is worse than no deadline: the handler stops
// (or does not) and nothing in the system says why the job failed. So the sink
// is the preferred route and `reportServerError` is the floor beneath it — an
// explicit branch, not an assumption that someone is listening.
//
// `emit()` returns `undefined` when nobody registered a handler (the
// `deadline-audit` sub-plugin is not in this composition, or has not reached its
// `onReady`), and `false` when a handler ran but did not durably record the
// event. Both mean the same thing to us — this event has no durable home — so
// both fall through to the server error reporter.
function announce(event: JobDeadlineEvent): void {
  const recorded = jobDeadlineSink.emit(event);
  if (recorded === true) return;

  // The recovery arm's floor is a LOG LINE, not a report, and that asymmetry is
  // deliberate. The two failure arms must never be silent — each is the only
  // record that a run was given up on. `unforfeited` is the opposite: it is an
  // update to a condition that was already durably recorded, and routing good
  // news through the server ERROR reporter would file it as a fault, which is
  // both wrong and the sort of thing that teaches people to ignore reports.
  if (event.phase === "unforfeited") {
    console.info(
      `[jobs] ${event.jobName} (job ${event.jobId}) finally settled after ${event.elapsedMs} ms — its forfeited ${event.hold} slot is back`,
    );
    return;
  }

  const message =
    event.phase === "zombie"
      ? `[jobs] ${event.jobName} (job ${event.jobId}) is a ZOMBIE — still holding a ${event.hold} slot ${event.elapsedMs} ms in, ${ZOMBIE_GRACE_MS} ms after its deadline aborted it`
      : `[jobs] ${event.jobName} (job ${event.jobId}, attempt ${event.attempt}) exceeded its ${event.hold} deadline of ${event.deadlineMs} ms (held ${event.elapsedMs} ms) — ctx.signal aborted`;
  console.warn(message);
  reportServerError({ message, stack: null, errorType: "JobDeadline" });
}
