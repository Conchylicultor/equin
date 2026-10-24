import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { JobCtx } from "@plugins/infra/plugins/jobs/server";
import {
  runEnded,
  type RunEndedPayload,
} from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { _releaseRuns } from "./tables";
import { RELEASE_RUN_KIND_ID } from "./kind-id";
import { releaseRunIdKind } from "@plugins/release/plugins/bundles/core";

/**
 * How long one suspension waits for the release's `supervisedRun.ended` before
 * waking anyway.
 *
 * The same five minutes `supervised-job` uses, and for the same reason: the wait
 * is a wake-up, the LEDGER is the authority, and a bounded re-look costs a lost
 * event one interval instead of the whole sequence.
 */
const RELEASE_WAIT_MS = 5 * 60 * 1000;

/**
 * How many wakes a run may stay un-claimed before the wait gives up on it.
 *
 * A release job dispatches in milliseconds, so a row that has still not appeared
 * after two full intervals is not slow — either its claim lost the race (the
 * arm below names the winner) or the queue is wedged and nothing is going to
 * dispatch. Ten minutes buys a badly-backed-up queue every reasonable chance
 * while still ending, rather than leaving a deploy suspended forever on a
 * release that will never exist.
 */
const MAX_PENDING_WAKES = 2;

/**
 * How a release a caller is sequencing ended. A value, never a throw — the
 * interesting non-success (*another release of this composition is already
 * running*) is a legitimate outcome a sequencer branches on, not a fault, and a
 * thrown `Error` would collapse it into "the build ran and failed".
 *
 * There is no artifact path on the success arm on purpose: what a sequencer
 * ships is whatever `resolveBundle` picks AFTER the build, never a path carried
 * over from before it.
 */
export type ReleaseEnded =
  | { readonly ok: true; readonly runId: string }
  | { readonly ok: false; readonly runId: string; readonly message: string };

/**
 * Where a release stands, read from its ledger row.
 *
 * The row rather than the exit marker, deliberately: `closeRow` writes the row
 * BEFORE the `supervisedRun.ended` emit, so by the time anything can wake the
 * row is already the complete answer — and unlike the marker it also states the
 * two things a marker cannot, namely whether the run was ever claimed at all and
 * what sentence to show a user.
 */
type ReleaseProgress =
  /** No row yet: the job has been enqueued but has not claimed. */
  | { readonly state: "pending" }
  /** No row, and another release of this composition holds the lock. */
  | { readonly state: "never-started"; readonly message: string }
  | { readonly state: "running" }
  | { readonly state: "ended"; readonly ended: ReleaseEnded };

async function observeRelease(opts: {
  releaseId: string;
  composition: string;
}): Promise<ReleaseProgress> {
  const [row] = await db
    .select({
      status: _releaseRuns.status,
      finishedAt: _releaseRuns.finishedAt,
      error: _releaseRuns.error,
    })
    .from(_releaseRuns)
    .where(eq(_releaseRuns.id, releaseRunIdKind.key(opts.releaseId)));

  if (row === undefined) {
    const conflict = await otherOpenRelease(opts);
    if (conflict === undefined) return { state: "pending" };
    return {
      state: "never-started",
      message:
        `The release of "${opts.composition}" never started: run ${conflict} of the same ` +
        `composition was already in flight and holds its build lock. Wait for it to ` +
        `finish, then re-run.`,
    };
  }
  if (row.finishedAt === null) return { state: "running" };
  if (row.status === "succeeded") {
    return { state: "ended", ended: { ok: true, runId: opts.releaseId } };
  }
  return {
    state: "ended",
    ended: {
      ok: false,
      runId: opts.releaseId,
      message: row.error ?? "The release failed without recording a reason.",
    },
  };
}

/** Another unfinished release of this composition in this namespace, if any. */
async function otherOpenRelease(opts: {
  releaseId: string;
  composition: string;
}): Promise<string | undefined> {
  const [row] = await db
    .select({ id: _releaseRuns.id })
    .from(_releaseRuns)
    .where(
      and(
        eq(_releaseRuns.namespace, runtimeNamespace()),
        eq(_releaseRuns.composition, opts.composition),
        ne(_releaseRuns.id, releaseRunIdKind.key(opts.releaseId)),
        isNull(_releaseRuns.finishedAt),
      ),
    );
  return row?.id;
}

/**
 * Wait, durably, for a release this workflow enqueued — across any number of
 * backend restarts.
 *
 * **This is what a caller sequencing a release uses instead of awaiting a
 * promise**, and the difference is the whole point of the migration: the Deploy
 * app's `update` used to `await runRelease(...)` in-process for tens of minutes
 * between its converge and its ship legs, and that await is precisely the window
 * the 2026-08-28 incident died in — an unrelated `./equin build` signalled
 * the process group and the deploy went with it. `ctx.waitFor` returns from the
 * handler through the jobs plugin's suspend sentinel, so nothing is holding
 * anything while the release runs, and the sequence resumes as a fresh dispatch
 * in whichever backend is alive when the release ends.
 *
 * It lives HERE rather than in the consumer because every fact it needs is this
 * plugin's: the kind id the event filters on, the ledger the outcome is read
 * from, and what a missing row means. A consumer that reached for those would be
 * re-deriving release's own semantics.
 *
 * **Observe before waiting.** The first thing this does is read the ledger, not
 * suspend — a release that is already over (or was never claimed) is answered
 * immediately rather than after an interval, and a lost event costs one wake
 * rather than the sequence.
 *
 * `name` prefixes the durable wait names, so a resume re-walks the same
 * suspensions in the same order rather than minting fresh ones. It must be
 * unique within the calling workflow.
 */
export async function awaitRelease(
  ctx: Pick<JobCtx, "waitFor">,
  opts: { releaseId: string; composition: string; name: string },
): Promise<ReleaseEnded> {
  for (let iteration = 0; ; iteration++) {
    const progress = await observeRelease(opts);
    if (progress.state === "ended") return progress.ended;
    if (progress.state === "never-started") {
      return { ok: false, runId: opts.releaseId, message: progress.message };
    }
    if (progress.state === "pending" && iteration >= MAX_PENDING_WAKES) {
      return {
        ok: false,
        runId: opts.releaseId,
        message:
          `The release job for run ${opts.releaseId} never claimed it, ${MAX_PENDING_WAKES} wake-ups ` +
          `after being enqueued. Nothing was built. Check Debug → Queue for a backed-up ` +
          `or dead-lettered "release.run.supervised".`,
      };
    }
    // The payload is discarded, deliberately — this is a wake-up and the ledger
    // is the authority. A timeout and an event are the same instruction here:
    // go and look.
    await ctx.waitFor<RunEndedPayload>(runEnded, {
      where: { kindId: RELEASE_RUN_KIND_ID, runId: opts.releaseId },
      timeoutMs: RELEASE_WAIT_MS,
      name: `${opts.name}:${iteration}`,
    });
  }
}
