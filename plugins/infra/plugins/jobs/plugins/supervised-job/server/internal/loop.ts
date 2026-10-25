import type { JobCtx } from "@plugins/infra/plugins/jobs/server";
import { observeRun, type RunTerminal } from "../../core";
import { assertRegistered, type SupervisedRunKind } from "./run/registry";
import { runEnded, type RunEndedPayload } from "./tables-run-ended";

/**
 * How long one suspension waits for `supervisedRun.ended` before waking anyway.
 *
 * The wait is bounded rather than `unbounded: true`, and the bound is what makes
 * a lost wake-up cost a delay instead of a run. Two independent things already
 * re-announce a live run — the supervising backend's liveness timer every
 * 60 s, and the boot reconcile of whatever backend comes up next — so this only
 * has to cover the case where NEITHER can: a kind whose own CLI stamped its
 * ledger row early (`./equin build` does, ~100 s before its child exits)
 * has already left `listUnfinished`, so a backend that restarts after the marker
 * landed will never re-announce it, and this timeout is the only thing that ever
 * closes the workflow.
 *
 * Five minutes is chosen against that cost, not against a latency target: a wake
 * is two `instant` dispatches and one `stat`, so a 30-minute build pays six of
 * them, and the worst-case lateness of a run's recorded outcome is one interval.
 * Shortening it buys nothing the 60 s liveness timer does not already provide on a
 * live backend; lengthening it delays exactly the restart case it exists for.
 */
const RUN_ENDED_WAIT_MS = 5 * 60 * 1000;

/**
 * Wait until one supervised run has ended, and answer HOW it ended.
 *
 * The observe-then-wait loop, exported because it is the whole of the close rule
 * in motion and a second copy of it would be a path nothing exercises until
 * something has already gone wrong. `superviseRuns` below calls it, so it sits
 * on the hot path rather than beside it and cannot drift from what every
 * supervised job depends on.
 *
 * **Observe first, wait second.** The marker is checked BEFORE every suspension,
 * which closes a race that would otherwise strand short runs:
 * `startSupervisedRun` settles a run whose marker is already on disk by the time
 * the spawn returns, so its announcement can fire while the caller is still
 * inside its spawn step, with no trigger armed to receive it. A wait-first loop
 * would then hang until its timeout on a run that was over before it started.
 * Observing first makes the wait a pure wake-up: losing one costs a timeout,
 * never the run.
 *
 * **The wait names are `${name}:${iteration}`**, so they are deterministic per
 * caller and per iteration. A replay after a resume re-walks the same names in
 * the same order: a settled wait row returns immediately (resolved or timed out)
 * and falls through to the next iteration, while only the first not-yet-settled
 * name arms a trigger — so a duplicate trigger for one iteration is not
 * expressible. Pass a `name` that is stable for the position in YOUR workflow
 * (`converge`, `ship`), never one derived from a clock or a counter that can
 * restart differently.
 *
 * **PRECONDITION: `pid` must be the pid of a child YOU started for this run.**
 * With no marker on disk, a pid that is not alive IS the hard-kill outcome —
 * that is the close rule, and it is correct for a row with no process behind it.
 * So `pid: null` returns the `-1` sentinel immediately, which is right for a run
 * you started and wrong for a run you merely know the id of. The worked example
 * is deploy's `update`: it waits on its own converge and ship legs through this
 * function, but its wait on the RELEASE leg — a run of someone else's kind,
 * whose pid it does not hold and which may not even have been claimed yet — must
 * NOT come here. That one resolves against `release_runs` instead.
 */
export async function awaitSupervisedRun(
  ctx: Pick<JobCtx, "waitFor">,
  opts: {
    /**
     * The kind handle, not an id: a handle can only be obtained by having
     * defined the kind, which makes waiting on a kind you do not own hard to
     * spell by accident.
     */
    readonly kind: SupervisedRunKind;
    readonly runId: string;
    /** The pid of the child you started — see the precondition above. */
    readonly pid: number | null;
    /** Stable prefix for this wait's position in your workflow. */
    readonly name: string;
  },
): Promise<RunTerminal> {
  // A kind nobody registered is a kind whose runs nothing reconciles and whose
  // end nothing announces, so this wait would burn its timeout forever. Loud at
  // the call site, exactly as `startSupervisedRun` is.
  assertRegistered(opts.kind);
  for (let iteration = 0; ; iteration++) {
    const observation = observeRun(
      opts.kind.id,
      opts.runId,
      opts.pid,
      new Date(),
    );
    if (observation.state === "ended") return observation.terminal;
    // The payload is discarded, deliberately — this is a wake-up, and the marker
    // is the authority. `null` (the timeout arm) and an event are the same
    // instruction here: go and look.
    await ctx.waitFor<RunEndedPayload>(runEnded, {
      where: { kindId: opts.kind.id, runId: opts.runId },
      timeoutMs: RUN_ENDED_WAIT_MS,
      name: `${opts.name}:${iteration}`,
    });
  }
}

/**
 * What this loop needs from a job context: memoized steps, the durable wait, and
 * the durable sleep between attempts.
 *
 * Structurally satisfied by `JobCtx`, so the handler passes `ctx` straight
 * through. Declared narrowly because the loop's correctness rests on exactly
 * these properties of the surrounding machinery — a step runs once per workflow
 * run and replays its result thereafter, and a wait or a sleep suspends and
 * resumes in the same order on every replay — so a test supplying them is
 * exercising the real algorithm rather than a rehearsal of it.
 */
export type LoopCtx = Pick<JobCtx, "step" | "waitFor" | "sleep">;

/** The cap on the durable backoff between two attempts. */
const MAX_BACKOFF_MS = 60_000;

/**
 * How long to wait, holding no slot, after attempt `attempt` failed and before
 * the next one claims: `e^attempt` seconds — about 3, 7, 20 and 55 s — capped at
 * a minute. A pure function of the attempt number, so a replay sleeps the same
 * sequence and the durable sleep names line up.
 */
export function backoffMsAfter(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, Math.round(Math.exp(attempt) * 1000));
}

/** One spawned child: the run it serves, and the process group it lives in. */
export interface StartedRunAttempt {
  readonly runId: string;
  readonly pid: number;
}

export interface SuperviseRunsSpec {
  /** The supervised-run kind these attempts belong to. */
  readonly kind: SupervisedRunKind;
  /** How many children may be spawned in sequence before giving up. */
  readonly runAttempts: number;
  readonly ctx: LoopCtx;
  /**
   * Claim the ledger row and spawn the child for `attempt`, or answer `null`
   * when the claim lost its race with a run that is already in flight.
   *
   * Called inside a step, so it happens exactly once per attempt per workflow —
   * a resume must never spawn a second child for a run it already started.
   */
  spawn(attempt: number): Promise<StartedRunAttempt | null>;
  /**
   * The ledger's bare terminal write — see `SupervisedJobLedger.closeRow`.
   *
   * Called for the previous attempt's run before the next attempt claims.
   * Ordinarily a no-op (the reconciler closed it when the marker landed), but
   * after a restart the next claim can otherwise lose to the previous attempt's
   * still-open row — and that loss, memoized, would end the ladder silently.
   */
  closeRow(runId: string, terminal: RunTerminal): Promise<void>;
  /**
   * The run has ENDED — do this kind's terminal work and answer whether the
   * ladder goes on: `done` stops it, `retry` spawns the next attempt (if one
   * is left). Called once per attempt that reached a terminal (and again on
   * every replay: it is not memoized, so the verdict must be deterministic),
   * before the next attempt claims. Throwing ends the ladder.
   */
  onEnded(
    started: StartedRunAttempt,
    terminal: RunTerminal,
    attempt: number,
  ): Promise<RunVerdict>;
}

/**
 * What one ended attempt means for the ladder. Never derived from the exit code
 * alone: a cancelled run fails, and must not be retried.
 */
export type RunVerdict = "done" | "retry";

export type SuperviseRunsResult =
  /** The claim lost its race: another run of this kind is already in flight. */
  | { readonly outcome: "not-claimed" }
  /** The last attempt reached a terminal. `terminal.exitCode` says which. */
  | {
      readonly outcome: "ended";
      readonly runId: string;
      readonly attempt: number;
      readonly terminal: RunTerminal;
    };

/**
 * Spawn a supervised run, wait for it to end, and repeat up to `runAttempts`
 * times while `onEnded` answers `retry`.
 *
 * The whole shape of a supervised job lives here, and it is short at both ends
 * and empty in the middle: spawn and suspend, then be woken and read the marker.
 * Nothing holds a worker slot while a child runs — `ctx.waitFor`
 * RETURNS from the handler through the jobs plugin's suspend sentinel, and the
 * workflow comes back as a fresh dispatch.
 *
 * **Observe first, wait second.** The check that decides whether to keep waiting
 * runs BEFORE every suspension, not after it, and that ordering closes a race
 * that would otherwise strand short runs forever: `startSupervisedRun` settles a
 * run whose marker is already on disk by the time the spawn returns, so its
 * `finish` — and therefore the `supervisedRun.ended` emit — can fire while this
 * handler is still inside the spawn step, with no trigger armed to receive it.
 * A wait-first loop would then hang until its timeout on a run that was over
 * before it started. Observing first makes the wait a pure wake-up: losing one
 * costs a timeout, never the run.
 *
 * **A retry is a new child.** When `runAttempts > 1`, the next iteration calls
 * `spawn` again and gets a fresh run id, a fresh transcript and a fresh marker —
 * out-of-process work cannot be resumed, only redone. Between two attempts the
 * loop sleeps durably ({@link backoffMsAfter}) and then calls `closeRow` on the
 * previous attempt's run, because the kind's partial unique in-flight index
 * would refuse the next claim while that row is still open. A retry that loses
 * its claim anyway throws — it is never a quiet "someone else is running".
 */
export async function superviseRuns(
  spec: SuperviseRunsSpec,
): Promise<SuperviseRunsResult> {
  let last: SuperviseRunsResult = { outcome: "not-claimed" };
  let previous: { runId: string; terminal: RunTerminal } | null = null;
  for (let attempt = 1; attempt <= spec.runAttempts; attempt++) {
    if (previous !== null) {
      // A durable backoff, holding no slot, then make sure the previous
      // attempt's row cannot win against this attempt's claim.
      await spec.ctx.sleep(backoffMsAfter(attempt - 1));
      await spec.closeRow(previous.runId, previous.terminal);
    }
    const started = await spec.ctx.step(`spawn:${attempt}`, () =>
      spec.spawn(attempt),
    );
    if (started === null) {
      if (attempt === 1) return { outcome: "not-claimed" };
      // A retry that loses its claim is not "someone else is running this": the
      // previous attempt's row was closed just above, so what holds the lock is
      // a run this workflow did not start, or a close that did not land.
      // Returning would end the ladder with the failure unrecorded.
      throw new Error(
        `[supervised-job] ${spec.kind.id}: attempt ${attempt} lost its claim ` +
          `after attempt ${attempt - 1} (${previous?.runId ?? "?"}) failed — ` +
          `the retry never ran.`,
      );
    }

    // `run-ended:<attempt>` as the prefix, so the durable wait names come out
    // `run-ended:<attempt>:<iteration>` — the spelling every supervised job has
    // used since this loop existed, and one an in-flight workflow's recorded
    // waits are keyed by. `loop.test.ts` asserts the literal strings.
    const terminal = await awaitSupervisedRun(spec.ctx, {
      kind: spec.kind,
      runId: started.runId,
      pid: started.pid,
      name: `run-ended:${attempt}`,
    });
    const verdict = await spec.onEnded(started, terminal, attempt);
    last = { outcome: "ended", runId: started.runId, attempt, terminal };
    if (verdict === "done") break;
    previous = { runId: started.runId, terminal };
  }
  return last;
}
