import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/server";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { releaseOutDir } from "@plugins/release/plugins/bundles/server";
import { ReleaseIntentSchema, type ReleaseIntent } from "../../core/endpoints";
import { releaseTargetById } from "../../core/targets";
import { collectReleaseEnv } from "./env-provider";
import { RELEASE_RUN_KIND_ID } from "./kind-id";
import { releaseLog } from "./release-log";
import { _releaseRuns } from "./tables";
import {
  claimRelease,
  closeReleaseRow,
  listUnfinished,
  setPid,
} from "./run-state";
import { releaseRunIdKind } from "@plugins/release/plugins/bundles/core";

/**
 * What one release request says.
 *
 * `releaseId` is minted by the CALLER rather than inside `claim`, and that is
 * the one thing about this input worth arguing for: a sequencing caller (the
 * Deploy app's `update`) has to name the run it is waiting on before that run
 * exists, because `ctx.waitFor(runEnded, { where: { kindId, runId } })` filters
 * on the id. Minting it here would leave the waiter with nothing to filter on.
 * The id is only a name — the LOCK is still the claiming INSERT below.
 */
const releaseJobInput = z.object({
  releaseId: z.string(),
  composition: z.string(),
  target: z.string(),
  /** See `ReleaseIntent` — decides `--dev` vs `--platform <tag>`, and `kind`. */
  intent: ReleaseIntentSchema,
});

export type ReleaseJobInput = z.infer<typeof releaseJobInput>;

/**
 * The argv difference the intent makes, and nothing else:
 *
 * - `staged`    → `--dev`, host platform. Staged only, no pointer claimed.
 * - `candidate` → NO `--dev` (it must pack, or it is not shippable) plus
 *                 `--platform <tag>` (it must be built for the host that will
 *                 run it, which is discovered, never typed).
 */
function intentArgs(intent: ReleaseIntent): string[] {
  return intent.kind === "staged" ? ["--dev"] : ["--platform", intent.platform];
}

/**
 * One `./equin release`, as an ordinary durable job.
 *
 * The handler claims the composition's single in-flight slot, spawns a detached
 * child and SUSPENDS — it holds a worker slot for milliseconds, not for the
 * twenty minutes a release takes. It is woken by the child's exit marker in
 * whichever backend is alive by then.
 *
 * **This is what replaced `runRelease` and its waiter map.** A supervised run's
 * outcome does not come back from the call that started it — it arrives at the
 * kind's `finish`, driven by a file watcher — and `internal/driving.ts` used to
 * absorb that inversion by handing the terminal to a promise the starting
 * process was holding. That worked only while the process lived, which is
 * exactly what the Deploy app's `update` could not rely on: it awaited a release
 * in-process for tens of minutes, and an unrelated `./equin build` ended
 * both. `ctx.waitFor` is that mechanism now, and it is durable, so the map is
 * gone rather than generalised.
 *
 * Nothing awaits this job as a promise. A caller enqueues and gets the run id
 * (`enqueueRelease`); a caller that needs the outcome waits for it durably
 * (`awaitRelease`).
 *
 * `runAttempts` is left at the default 1: a failed release stays failed and
 * visible, and re-running one is a decision, not a retry budget.
 */
export const releaseJob = defineSupervisedJob({
  name: "release.run.supervised",
  description:
    "Builds a standalone release of a composition and records whether it succeeded.",
  input: releaseJobInput,

  channel: releaseLog,

  ledger: {
    kindId: RELEASE_RUN_KIND_ID,
    listUnfinished,
    setPid,
    // The bare terminal stamp, and nothing else. Everything with a side effect
    // is `onEnded` below, which runs exactly once in the owning workflow.
    //
    // There is no `onReattach`: a release keeps no in-memory live view. Its UI
    // reads the ledger row plus the log channel, and by the time a kind's
    // `onReattach` would be called the primitive has already restarted the
    // transcript tail, so an adopted release is back on screen with nothing for
    // this plugin to rebuild.
    closeRow: closeReleaseRow,

    /**
     * The claim IS the lock. Losing it means another release of this composition
     * is already in flight, and the handler then stops with nothing spawned — the
     * `already-running` outcome, reached the only way that is safe under
     * concurrency.
     */
    claim: async (input) =>
      (await claimRelease({
        releaseId: input.releaseId,
        composition: input.composition,
        target: input.target,
        intent: input.intent,
      }))
        ? input.releaseId
        : null,
  },

  /**
   * Async because the environment is ASSEMBLED: other plugins contribute extra
   * env for this target through the `Release.EnvProvider` slot (apple-signing
   * contributes `APPLE_*` for `tauri`), and the engine never names them —
   * collection-consumer separation. Those values are secrets, which is the
   * other reason they are collected here rather than carried in `input`: a job's
   * input is persisted verbatim in the graphile payload.
   *
   * Collected inside the spawn step, so a contributor that throws fails the
   * spawn — and `spawnClaimedRun` then closes the row it would otherwise have
   * left holding the composition's lock.
   */
  argv: async (input, runId) => {
    const target = releaseTargetById(input.target);
    // The endpoint validates the target before enqueuing, so reaching this with
    // an unimplemented one is a bug rather than a user error — loud, and inside
    // the spawn step, where the compensating close is already wired.
    if (!target?.implemented) {
      throw new Error(
        `[release] unknown or unimplemented release target: ${input.target}`,
      );
    }
    const argv = [
      `./${CLI_NAME}`,
      "release",
      "--composition",
      input.composition,
      ...target.buildArgs(input.composition),
      ...intentArgs(input.intent),
      "--out",
      releaseOutDir(runtimeNamespace(), input.composition, input.target, runId),
    ];
    releaseLog.publish(`$ ${argv.join(" ")}`);
    return {
      argv,
      cwd: REPO_ROOT,
      // ADDED to this backend's environment, not a replacement for it: the CLI
      // needs everything the backend was started with, plus these.
      envOverrides: await collectReleaseEnv(input.target),
    };
  },

  /**
   * The terminal WORK: say how it went, on the channel the run's own transcript
   * streams into.
   *
   * The row is ALREADY closed by `closeRow` when this runs — that is the
   * ordinary case, not a race — so the sentence is read back off the row rather
   * than recomputed. That is what keeps the line a user sees in the log and the
   * text stored on the row identical by construction instead of by agreement.
   */
  onEnded: async (releaseId) => {
    const [row] = await db
      .select({ status: _releaseRuns.status, error: _releaseRuns.error })
      .from(_releaseRuns)
      .where(eq(_releaseRuns.id, releaseRunIdKind.key(releaseId)));
    if (row === undefined) {
      // The claim inserted this row and nothing deletes `release_runs`, so its
      // absence is a real fault rather than a state to tolerate. Throwing fails
      // the job, which is the loud outcome a missing ledger row deserves.
      throw new Error(
        `[release] run ${releaseId} ended but has no ledger row to report.`,
      );
    }
    if (row.status === "succeeded") {
      releaseLog.publish("Release succeeded");
      return;
    }
    releaseLog.publish(
      row.error ?? "The release failed without recording a reason.",
      "stderr",
    );
  },
});
