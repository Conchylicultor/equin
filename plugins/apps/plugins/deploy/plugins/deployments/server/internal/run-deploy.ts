import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/server";
import {
  isSuspendSignal,
  NonRetryableError,
  type JobCtx,
} from "@plugins/infra/plugins/jobs/server";
import {
  defineSupervisedJob,
  type RunStep,
} from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import type { RunTerminal } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import { serverHealth } from "@plugins/apps/plugins/deploy/plugins/health/server";
import { awaitRelease, enqueueRelease } from "@plugins/release/server";
import {
  compareToHead,
  resolveBundle,
} from "@plugins/release/plugins/bundles/server";
import { bundleRefusalMessage } from "@plugins/release/plugins/bundles/core";
import { isPlatformTag, type PlatformTag } from "@plugins/release/core";
import type { Deployment } from "../../core/schemas";
import {
  DeployRunSchema,
  type DeployPhase,
  type DeployRun,
  type DeployVerb,
} from "../../core/runs";
import type { RunDeploymentBody } from "../../core/endpoints";
import { deployLog } from "./deploy-log";
import { legArgv, type DeployLeg } from "./legs";
import { readTranscriptTail } from "./transcript";
import { verbSucceeded, type VerbEnding } from "./verb-outcome";
import {
  beginLeg,
  claimRun,
  deployRunLedger,
  failRun,
  holdRunForApproval,
  pinShipBundle,
  setRunPhase,
} from "./run-state";
import { _deployRuns } from "./tables";
import { deployRunIdKind } from "../../core/id-kinds";
import { checkDeployGates, DeployGates } from "./gate";

/** The target this app deploys. Web is the only implemented remote target. */
const RELEASE_TARGET = "web";

/**
 * Launch a verb for one deployment: claim the server, then hand the sequence to
 * the queue.
 *
 * **The claiming INSERT is the exclusivity lock**, and it happens HERE rather
 * than in the handler because its refusal is a 409 that has to reach the button
 * that was clicked. Scoped to the SERVER, not the deployment — converge writes
 * `/etc/caddy/Caddyfile` and runs `apt-get`, so two of them on one box race even
 * when they are different compositions. An `update` holds the server for its
 * whole sequence, which is right for the same reason: both of its legs mutate
 * host-wide state.
 */
export async function startDeployRun(opts: {
  deployment: Deployment;
  body: RunDeploymentBody;
}): Promise<DeployRun> {
  const run = await claimRun(opts);
  try {
    await deployRunJob.enqueue({ runId: run.id });
  } catch (err) {
    // The row is the server's lock, so a request that could not be queued must
    // not leave it held. Reported as a failed run AND rethrown: the caller asked
    // for a deploy and did not get one.
    await failRun(
      run.id,
      `Could not queue this deploy: ${err instanceof Error ? err.message : String(err)}`,
      "converge",
    );
    throw err;
  }
  return run;
}

const deployRunJobInput = z.object({ runId: z.string() });

/**
 * One deploy run, as a durable sequence of supervised children.
 *
 * **This is the migration's whole point.** `update` is converge → build a
 * candidate → ship, and it used to be one in-process async function that
 * `await`ed a release for tens of minutes in the middle. That await is exactly
 * the window the 2026-08-28 incident died in: an unrelated `./equin build`
 * hot-restarted the backend, the gateway signalled its process group, and
 * `drun-1787890652933-wr3v6d` lost its ship 0.9 s after spawning it.
 *
 * A `defineSupervisedJob` `steps` body: each leg is a `step` — spawned detached
 * inside a memoized step, then waited on with the shared observe-then-wait loop
 * — and every other gap is a `ctx.step` or a `ctx.waitFor`. So the handler
 * returns through the jobs plugin's suspend sentinel and comes back as a fresh
 * dispatch in whichever backend is alive by then. Nothing holds a worker slot
 * while a leg or a release runs.
 *
 * **The step names ARE the leg names** (`converge`, `ship`), so a step's child
 * id `<runId>.<step>` is `legRunId(runId, leg)` — the id the ledger records and
 * the transcript and marker are named by.
 *
 * `hold` is **`seconds`**, not `instant`: what bounds a dispatch is one `git`
 * read (`compareToHead`, behind the shared heavy-read pool) plus a handful of
 * indexed queries. `instant` would be a claim of no blocking I/O that a `git`
 * invocation makes false.
 *
 * The ledger's `claim` ADOPTS the row the endpoint claimed (`startDeployRun`),
 * answering `null` when it is already closed, so a job for a finished run
 * sequences nothing.
 */
export const deployRunJob = defineSupervisedJob({
  name: "deploy.run",
  description:
    "Deploys a composition to its server, preparing the machine then shipping the release, and records the outcome.",
  input: deployRunJobInput,
  channel: deployLog,
  hold: "seconds",
  ledger: deployRunLedger,
  steps: (input, { step, ctx }) => runDeploy(input.runId, step, ctx),
});

/** The ledger facts the sequence runs on. Immutable for the life of the run. */
interface OpenRun {
  id: string;
  verb: DeployVerb;
  deploymentId: string;
  compositionId: string;
  serverId: string;
  releaseRunId: string | null;
}

/**
 * The run this workflow is for, read on every dispatch rather than carried in
 * the input, so a resumed sequence cannot act on a stale copy. Whether it is
 * still OPEN is not decided here: the claim decided that once, and afterwards a
 * closed run surfaces where it matters — a leg's `beginStep` refusing, or a
 * leg's failed terminal.
 */
async function loadRun(runId: string): Promise<OpenRun> {
  const [row] = await db
    .select()
    .from(_deployRuns)
    .where(eq(_deployRuns.id, deployRunIdKind.key(runId)));
  if (!row) {
    throw new Error(`[deploy] no run row for ${runId} — nothing to sequence.`);
  }
  return {
    id: row.id,
    // Parsed rather than cast: a `verb` outside the union would otherwise reach
    // `finalLeg` and decide, silently, that this run has no last leg.
    verb: DeployRunSchema.shape.verb.parse(row.verb),
    deploymentId: row.deploymentId,
    compositionId: row.compositionId,
    serverId: row.serverId,
    releaseRunId: row.releaseRunId,
  };
}

async function runDeploy(
  runId: string,
  step: RunStep,
  ctx: JobCtx,
): Promise<void> {
  const run = await loadRun(runId);

  // The phase a failure would be attributed to, advanced as the sequence moves.
  // A single-verb run has no phases and `publishLiveRun` drops it; it is carried
  // anyway so the catch-all below has one honest answer for every verb.
  let phase: DeployPhase = run.verb === "ship" ? "ship" : "converge";
  try {
    // The gates come before EVERY verb and before anything else: a run one of
    // them refuses ends `needs-approval` having converged and shipped nothing.
    // Memoized, so a resumed sequence is not re-judged halfway through.
    const verdict = await ctx.step("gate", () =>
      checkDeployGates(
        { deploymentId: run.deploymentId, compositionId: run.compositionId },
        DeployGates.Gate.getContributions(),
      ),
    );
    if (verdict.kind === "needs-approval") {
      await holdRunForApproval(run.id, verdict.message, verdict.resolveIn);
      return;
    }
    if (run.verb === "update") {
      await runUpdate(run, step, ctx, (next) => {
        phase = next;
      });
    } else {
      await runLeg(run, step, ctx, run.verb, legArgv(run, run.verb));
    }
  } catch (err) {
    // `ctx.waitFor` returns from the handler by THROWING a suspend sentinel, so
    // it must reach the worker untouched — catching it here would hang the
    // workflow forever.
    if (isSuspendSignal(err)) throw err;
    // The row is the server's exclusivity lock, so an escaping exception is not
    // just a lost status: it would hold that server until something reconciled
    // it. Stamped AND rethrown — the run gets its verdict, and the job still
    // fails loudly and earns its report.
    const message = err instanceof Error ? err.message : String(err);
    await failRun(run.id, message, phase);
    // Non-retryable once the run carries its verdict: a retry replays the
    // memoized claim and steps against a closed run, so it cannot redo anything
    // — it would only re-fail until the job dead-letters. One attempt, still a
    // loud dead-letter. (A `failRun` that itself threw skips this, so a
    // transient DB failure keeps its retry.)
    throw new NonRetryableError(message, { cause: err });
  }
  // The factory releases the workflow's suspension state once this returns.
}

/**
 * The one-button sequence: converge the host, build a candidate unless the
 * existing bundle is already current, then ship exactly the run id that
 * resolved.
 *
 * Nothing here re-implements a refusal. The two host-mutating legs are the same
 * CLI commands the row actions launch, and the build/no-build decision is
 * `resolveBundle` + `compareToHead` — the same authority `ship` itself consults,
 * asked one step earlier so the user does not have to. Each leg's failure ends
 * the run with that leg's own words (written by the ledger's `closeRow`, not
 * from here), and `phase` is left pointing at the leg that failed.
 *
 * The durable names here (`platform`, `begin-ship`, `bundle-decision`,
 * `enqueue-release`, `release:<i>`, `pin-bundle`, `ended:<leg>`) are the ones
 * the pre-`steps` sequence recorded, so a deploy suspended across that change
 * resumes where it was. Only `pin-ship` is new, and replays harmlessly.
 */
async function runUpdate(
  run: OpenRun,
  step: RunStep,
  ctx: JobCtx,
  setPhase: (phase: DeployPhase) => void,
): Promise<void> {
  await setRunPhase(run.id, "converge");

  // Read the platform BEFORE touching the host: an update that cannot resolve a
  // bundle is going to fail anyway, and failing before the converge means the
  // user reads the real reason instead of a converge log they have to scroll
  // past. Server-side off the health side-table, never from the client — the
  // platform is DISCOVERED by the probe, and a body field carrying it would be a
  // place to get it wrong.
  const platform = await ctx.step("platform", () => resolvePlatform(run));
  if (!platform.ok) {
    await failRun(run.id, platform.message, "converge");
    return;
  }

  // 1. Converge. A no-op on an already-correct host (every file lands through a
  //    content-compare `put`, and the restart is gated on the running process
  //    predating its configuration), so running it before every ship costs a
  //    warm host nothing and repairs drift on a cold one.
  const converge = await runLeg(
    run,
    step,
    ctx,
    "converge",
    legArgv(run, "converge"),
  );
  if (!converge.ok) return;

  // Point the ledger at the ship leg BEFORE the build, not when the ship is
  // spawned. The build is the long part — often tens of minutes — and for all of
  // it the row must name a leg that has not run yet rather than the converge
  // that just finished: a row still pointing at a leg with an exit marker reads
  // as a finished run to anything that looks. `listUnfinished` skips a leg with
  // no transcript, so naming an unspawned leg does not offer it to the
  // reconciler to close.
  if (
    !(await ctx.step(
      "begin-ship",
      async () => (await beginLeg(run.id, "ship")) !== null,
    ))
  ) {
    return;
  }

  setPhase("build");
  await setRunPhase(run.id, "build");

  // 2. Build — unless there is already a bundle that ship would accept AND it
  //    was cut from this exact HEAD. Anything short of `current` rebuilds: a
  //    dirty worktree is `unknown`, never `current`, so a work-in-progress tree
  //    always gets fresh bytes.
  const decision = await ctx.step("bundle-decision", () =>
    decideBuild(run.compositionId, platform.platform),
  );
  if (decision.build) {
    // Enqueued in a step so a resume cannot request a second release, and the id
    // is minted by `enqueueRelease` so this workflow can name the run it is
    // about to wait for. The wait itself is `release`'s — it knows its own kind
    // id, its ledger, and what a run that was never claimed means.
    const releaseId = await ctx.step("enqueue-release", () =>
      enqueueRelease({
        composition: run.compositionId,
        target: RELEASE_TARGET,
        intent: { kind: "candidate", platform: platform.platform },
      }),
    );
    const released = await awaitRelease(ctx, {
      releaseId,
      composition: run.compositionId,
      name: "release",
    });
    if (!released.ok) {
      await failRun(run.id, released.message, "build");
      return;
    }
  }

  // 3. Ship, pinned by run id. Re-resolved rather than reusing the bundle the
  //    decision above looked at: a build that just ran moved the
  //    `latest-<platform>` pointer, and the whole point of pinning is that what
  //    was resolved HERE is what goes out.
  const pinned = await ctx.step("pin-bundle", () =>
    pinBundle(run.compositionId, platform.platform),
  );
  if (!pinned.ok) {
    await failRun(run.id, pinned.message, "build");
    return;
  }
  // The row names what it is about to ship before the ship leg can begin.
  await ctx.step("pin-ship", () =>
    pinShipBundle(run.id, {
      release: pinned.runId,
      commitSha: pinned.commitSha,
    }),
  );
  setPhase("ship");
  await setRunPhase(run.id, "ship");
  await runLeg(
    run,
    step,
    ctx,
    "ship",
    legArgv({ ...run, releaseRunId: pinned.runId }, "ship"),
  );
}

/** What one leg did, as far as the SEQUENCE is concerned. */
interface LegResult {
  /** Did this leg do what it was asked? `false` also covers "it never ran". */
  readonly ok: boolean;
}

/**
 * Run one CLI leg as a step and say whether it succeeded — **without stamping
 * the run**.
 *
 * The stamp is the ledger's `closeRow`, in the supervisor's reconciler, and that
 * split is the durability: a leg's outcome is recorded from its own exit marker
 * by whichever backend sees it end, whether or not this workflow is still alive
 * to notice. What happens here is only what the sequence needs — is there more
 * to do? A leg whose run was closed before it could begin (`run-closed`) has
 * nothing to add to what the row already carries.
 */
async function runLeg(
  run: OpenRun,
  step: RunStep,
  ctx: JobCtx,
  leg: DeployLeg,
  argv: readonly string[],
): Promise<LegResult> {
  const outcome = await step(leg, { argv, cwd: REPO_ROOT });
  if (outcome.state === "run-closed") return { ok: false };
  if (outcome.state === "not-started") {
    // No process ever ran (no `./equin`, EAGAIN), so there is no exit
    // code and no transcript to quote: the run's verdict is this sentence. The
    // factory closes the leg's row only after this, and only if it is still open.
    deployLog.publish(
      `[failed] could not run ${argv.join(" ")}: ${outcome.message}`,
      "stderr",
    );
    await failRun(
      run.id,
      `could not run \`deploy ${leg}\`: ${outcome.message}`,
      leg,
    );
    return { ok: false };
  }

  // Memoized, so a resume that re-walks the sequence does not re-announce a leg
  // that ended twenty minutes ago — every wake of the release wait replays this
  // path, and a `[done] deploy converge` per wake would be six of them on one
  // build. It also means the transcript tail is read once rather than per wake.
  return ctx.step(`ended:${leg}`, () =>
    announceLeg(run, leg, outcome.runId, outcome.terminal),
  );
}

/** Say how a leg ended on the `deploy` channel, and answer the sequence. */
function announceLeg(
  run: OpenRun,
  leg: DeployLeg,
  legId: string,
  terminal: RunTerminal,
): LegResult {
  const ending: VerbEnding = {
    verb: leg,
    exitCode: terminal.exitCode,
    signalCode: terminal.signalCode,
    lines: readTranscriptTail(legId),
  };
  if (verbSucceeded(ending)) {
    deployLog.publish(`[done] deploy ${leg} ${run.compositionId}`);
    return { ok: true };
  }
  deployLog.publish(
    ending.signalCode === null
      ? `[failed] deploy ${leg} exited ${ending.exitCode}`
      : `[failed] deploy ${leg} was killed by ${ending.signalCode}`,
    "stderr",
  );
  return { ok: false };
}

type PlatformResult =
  | { readonly ok: true; readonly platform: PlatformTag }
  | { readonly ok: false; readonly message: string };

async function resolvePlatform(run: OpenRun): Promise<PlatformResult> {
  const health = await serverHealth.get(run.serverId);
  if (!health?.ok) {
    return {
      ok: false,
      message:
        "This server has no successful reachability check — run Verify connection first.",
    };
  }
  if (health.platform === null || !isPlatformTag(health.platform)) {
    return {
      ok: false,
      message:
        `This server reported platform ${health.platform ?? "unknown"}, which no release target ` +
        `builds for, so no bundle can be shipped to it.`,
    };
  }
  return { ok: true, platform: health.platform };
}

/**
 * Is there already a bundle `ship` would accept, cut from this exact HEAD?
 *
 * Whichever way it goes, SAY so: "why did this deploy take twelve minutes" and
 * "why did it ship something older than my tree" are the two questions an
 * automatic decision has to answer without being asked. The lines are published
 * from inside the step, so a resume does not repeat them.
 */
async function decideBuild(
  composition: string,
  platform: PlatformTag,
): Promise<{ build: boolean }> {
  const existing = resolveBundle({
    namespace: runtimeNamespace(),
    composition,
    platform,
  });
  if (!existing.ok) {
    deployLog.publish(
      `[build] no shippable ${platform} bundle for ${composition}: ` +
        bundleRefusalMessage(existing.refusal),
    );
    return { build: true };
  }
  const staleness = await compareToHead(existing.manifest, REPO_ROOT);
  const reuse = staleness.kind === "current";
  deployLog.publish(
    reuse
      ? `[skip] build — ${platform} bundle ${existing.runId} is already built from the current HEAD.`
      : `[build] the ${platform} bundle ${existing.runId} is ${staleness.kind} vs HEAD — ` +
          `cutting a fresh candidate of ${composition}.`,
  );
  return { build: !reuse };
}

type PinResult =
  | {
      readonly ok: true;
      readonly runId: string;
      /**
       * The pinned bundle's OWN manifest is the honest answer to "which commit
       * is going onto the box" — not HEAD, which is a fact about this checkout
       * and would be a plausible lie the moment the bundle is reused or the tree
       * moves. Null when the manifest carries none (a build predating
       * provenance).
       */
      readonly commitSha: string | null;
    }
  | { readonly ok: false; readonly message: string };

function pinBundle(composition: string, platform: PlatformTag): PinResult {
  const pinned = resolveBundle({
    namespace: runtimeNamespace(),
    composition,
    platform,
  });
  if (!pinned.ok) {
    return { ok: false, message: bundleRefusalMessage(pinned.refusal) };
  }
  return {
    ok: true,
    runId: pinned.runId,
    commitSha: pinned.manifest.commitSha ?? null,
  };
}
