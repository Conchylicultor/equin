import {
  NonRetryableError,
  type JobCtx,
} from "@plugins/infra/plugins/jobs/server";
import {
  runEnded,
  type RunEndedPayload,
  type SupervisedRunRow,
} from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import type { CheckoutState } from "@plugins/infra/plugins/worktree/server";
import { SUPERVISED_EXIT_TEMPFAIL } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";

/**
 * How long one suspension waits for a prepare run's `supervisedRun.ended`
 * before looking again. The event is only a wake-up (the checkout on disk is
 * the authority), so a lost one costs this much, never the spawn — short,
 * because a launch is waiting on it.
 */
export const PREPARE_WAIT_MS = 30_000;

/** How many prepare runs one spawn requests before it gives up. */
export const MAX_PREPARE_REQUESTS = 3;

/**
 * How many times one spawn re-requests a run that exited EX_TEMPFAIL — the
 * child's database connection was refused because the database was full
 * (pgbouncer's `max_client_conn`). Such a run is back-pressure, not a failed
 * checkout, so it does not count against `MAX_PREPARE_REQUESTS`: on 2026-10-28
 * three requests burned out inside one 15-second storm and the task's launch
 * was lost with them. Its own budget, spread by {@link tempfailBackoffMs}
 * (~12 min in all), outlasts a storm; a database still full after that is
 * something else, and fails loudly.
 */
export const MAX_TEMPFAIL_REQUESTS = 8;

/**
 * The durable pause before the `n`-th (0-based) re-request after an EX_TEMPFAIL
 * run: 15 s doubling, capped at 2 min. A pure function of `n`, so a replay
 * pauses the same sequence.
 */
export function tempfailBackoffMs(n: number): number {
  return Math.min(120_000, 15_000 * 2 ** n);
}

/**
 * How many wakes a request may go without a run of its own appearing before it
 * counts as lost and is made again (~2 min). `worktree.prepare` is an `instant`
 * job that claims in milliseconds, so a request still unclaimed after that was
 * absorbed — its claim lost to a run that was already ending — or is stuck
 * behind a wedged queue; either way asking again is the way forward, and it
 * counts against `MAX_PREPARE_REQUESTS`.
 */
const MAX_PENDING_WAKES = 4;

/** What the loop reads and does — bound to the real job in `worktree-workspace.ts`. */
export interface PrepareDeps {
  /** Where the checkout stands on disk (`checkoutState`): the authority. */
  checkoutState(): Promise<CheckoutState>;
  /** The newest `worktree.prepare` run for this attempt (`latestSupervisedRun`). */
  latestRun(): Promise<SupervisedRunRow | null>;
  /** Ask for a prepare run (`worktreePrepareJob.enqueue`). */
  request(): Promise<void>;
  /** Take over a complete checkout in process (`adoptCompleteCheckout`). */
  adopt(): Promise<void>;
  /** The prepare job's supervised-run kind id, which `runEnded` filters on. */
  readonly kindId: string;
}

/**
 * Make the attempt's checkout exist — by waiting, durably, on the supervised
 * `worktree.prepare` child that makes it, never by making it here.
 *
 * Observe before waiting (`release`'s `awaitRelease` shape): each pass reads
 * the newest run and the checkout, and only then suspends.
 *
 * - A run is open → wait for it to end. Checked FIRST: a checkout can read
 *   complete while its child still installs it, and nothing here may race the
 *   child.
 * - The checkout is complete → adopt it in process (re-lock, non-frozen
 *   install) and return. The resume path: a conversation whose checkout exists
 *   pays no child.
 * - Otherwise a run is needed. Our last request's run exited EX_TEMPFAIL (the
 *   database refused its connection, full) → pause durably and request again,
 *   from its own budget (`MAX_TEMPFAIL_REQUESTS`). Our last request's run
 *   ended any other way without a complete checkout → request again, up to
 *   `MAX_PREPARE_REQUESTS`, then a `NonRetryableError` carrying that run's
 *   recorded error (the spawn records it and dead-letters). Our request has no
 *   run yet → wait for one.
 *
 * Replay-safe, which is the point: the spawn's run id is keyed per
 * conversation, so a graphile retry or a resume re-walks this loop from the
 * top. Each request is its own memoized step (`prepare:request:<n>`, whose value
 * is the run that was newest when it was made) walked in order, so a replay re-reads the requests it
 * already made instead of making them again, and the retry ladder lives HERE —
 * a thrown failure would make graphile replay the same memoized request
 * forever. A wait name a replay reaches in a different state is already
 * resolved and just costs a re-look.
 */
export async function prepareWorktree(
  ctx: Pick<JobCtx, "step" | "waitFor" | "sleep">,
  attemptId: string,
  deps: PrepareDeps,
): Promise<void> {
  // Our latest request, as the run that was newest when it was made (`null`:
  // none): a run other than that one is the request's. By identity, not by
  // clock — the run's start is the database's time, the request the backend's.
  let request: { after: string | null } | null = null;
  let requests = 0;
  let tempfails = 0;
  let pendingWakes = 0;
  for (let i = 0; ; i++) {
    const run = await deps.latestRun();
    if (run?.open) {
      await wait(ctx, deps.kindId, run.id, i);
      continue;
    }
    if ((await deps.checkoutState()) === "complete") {
      await deps.adopt();
      return;
    }
    const ours = request !== null && run !== null && run.id !== request.after;
    if (request !== null && !ours && pendingWakes < MAX_PENDING_WAKES) {
      // Requested, not claimed yet: wait for any run of the kind to end — ours
      // ends with one, and a timeout is a re-look.
      pendingWakes++;
      await wait(ctx, deps.kindId, null, i);
      continue;
    }
    if (ours && run.exitCode === SUPERVISED_EXIT_TEMPFAIL) {
      // Back-pressure, not a failed checkout: the child could not get a
      // database connection. Wait it out and ask again, without spending a
      // request — losing the launch to a full pooler is what this exists for.
      if (tempfails >= MAX_TEMPFAIL_REQUESTS) {
        throw new NonRetryableError(
          `The checkout of ${attemptId} could not start: its last ${String(tempfails + 1)} runs ` +
            `(last ${run.id}) were refused a database connection because the database was full ` +
            `(EX_TEMPFAIL), over ~${String(Math.round(totalTempfailBackoffMs() / 60_000))} min. ` +
            "Something is holding the pooler's connections — see pgbouncer's log.",
        );
      }
      await ctx.sleep(tempfailBackoffMs(tempfails));
      const after: string = run.id;
      request = await ctx.step(
        `prepare:retry:${String(tempfails)}`,
        async () => {
          await deps.request();
          return { after };
        },
      );
      tempfails++;
      pendingWakes = 0;
      continue;
    }
    if (requests >= MAX_PREPARE_REQUESTS) {
      throw new NonRetryableError(
        `The checkout of ${attemptId} was requested ${requests} times and is still not complete. ` +
          (run === null
            ? "No worktree.prepare run ever claimed it — check Debug → Queue."
            : `Last run ${run.id} ${run.exitCode === -1 ? "was killed (no exit marker)" : `exited ${String(run.exitCode)}`}: ` +
              `${run.errorMessage ?? "killed or crashed before recording an error — see the worktree-prepare log"}`),
      );
    }
    const after: string | null = run?.id ?? null;
    request = await ctx.step(`prepare:request:${requests}`, async () => {
      await deps.request();
      return { after };
    });
    requests++;
    pendingWakes = 0;
  }
}

function totalTempfailBackoffMs(): number {
  let total = 0;
  for (let n = 0; n < MAX_TEMPFAIL_REQUESTS; n++) total += tempfailBackoffMs(n);
  return total;
}

async function wait(
  ctx: Pick<JobCtx, "waitFor">,
  kindId: string,
  runId: string | null,
  i: number,
): Promise<void> {
  // The payload is discarded: a wake-up, never the answer. A timeout and an
  // event are the same instruction — go and look.
  await ctx.waitFor<RunEndedPayload>(runEnded, {
    where: runId === null ? { kindId } : { kindId, runId },
    timeoutMs: PREPARE_WAIT_MS,
    name: `prepare:wait:${i}`,
  });
}
