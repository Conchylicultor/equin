import { z } from "zod";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/server";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import { isMainCompositionBuild } from "@plugins/build/core";
import {
  BUILD_RUN_KIND_ID,
  buildRunIdKind,
} from "@plugins/build/plugins/run-ledger/core";
import { buildLog } from "./build-log";
import {
  claimBuildRun,
  closeBuildRow,
  listUnfinished,
  notifyBuildStarted,
  onBuildEnded,
  setPid,
} from "./run-state";

/**
 * What one build request says. A SET of compositions, or nothing at all.
 *
 * `compositions` is a set because one invocation is one shared build — one
 * install, one codegen, one checks pass, one transcript, one `build_runs` row
 * with N chips. Rebuilding three drifted compositions is therefore one enqueue,
 * not three queued behind each other's `.build.lock`.
 *
 * **`.min(1)` rather than a thrown guard at the top of a function.** An empty set
 * is a caller bug, not "build the main app": it would spawn `--composition` with
 * no ids and mint a row whose `targets` is `{}` — a run that is an attempt for
 * nothing, so no composition's termination clause could ever see it. The schema
 * is parsed at `.enqueue()`, which is where the caller is, so the mistake is
 * unspellable rather than merely rejected inside a detached child.
 */
const buildJobInput = z.object({
  trigger: z.enum(["manual", "auto"]),
  compositions: z
    .array(z.string())
    .min(
      1,
      "compositions was an empty set — omit the field to build this checkout's own app.",
    )
    .optional(),
});

type BuildJobInput = z.infer<typeof buildJobInput>;

/**
 * WHAT one invocation builds: the compositions it names, or this checkout's own
 * app. Derived in one place so the ledger row, the argv and the notification
 * cannot disagree about it.
 */
function targetsOf(input: BuildJobInput): string[] {
  return [...(input.compositions ?? [MAIN_COMPOSITION_ID])];
}

/**
 * One `./singularity build`, as an ordinary durable job.
 *
 * The handler claims this namespace's single in-flight slot, spawns a detached
 * child and SUSPENDS — it holds a worker slot for milliseconds, not for the
 * length of a build. It is woken by the child's exit marker in whichever backend
 * is alive by then, which matters more here than for any other supervised kind:
 * **`./singularity build` restarts the very backend that spawned it**, so the
 * process that started a build is routinely not the one that sees it end.
 *
 * Nothing waits on a build. A caller enqueues and returns, and everything a
 * finished build causes — the bell, the deployment notify, the convergence
 * reconcile — is `onBuildEnded`.
 *
 * `runAttempts` is left at the default 1. A failed build stays failed and
 * visible; the convergence loop is what decides whether to build again, from the
 * state of the world rather than from a retry budget.
 */
export const buildJob = defineSupervisedJob({
  name: "build.run.supervised",
  description:
    "Builds a composition and deploys it to its local namespace, recording the outcome.",
  input: buildJobInput,

  channel: buildLog,

  ledger: {
    kindId: BUILD_RUN_KIND_ID,
    listUnfinished,
    setPid,
    // The bare terminal stamp, and nothing else. Everything with a side effect
    // is `onEnded` below, which runs exactly once in the owning workflow.
    //
    // There is no `onReattach`: a build keeps no in-memory live view. Its UI
    // reads the ledger row plus the `build` log channel, and the primitive has
    // already restarted the transcript tail by the time `onReattach` would be
    // called — which is what makes a build's output keep scrolling across the
    // restart the build itself causes.
    closeRow: closeBuildRow,

    /**
     * The claim IS the lock, and it is taken inside the handler's memoized spawn
     * step. A request that lost the race simply stops: auto-build is a convergence
     * loop, so it is re-derived at the next edge rather than queued.
     *
     * `getHeadCommit()` is sampled HERE rather than at the enqueue, so the row
     * names the tree the build actually starts on rather than whatever the
     * checkout was on when the request was made. It is not a baseline anyone
     * carries — the convergence decision is re-derived from durable state at every
     * terminal edge (see `reconcileDeployment`), which is what survives this
     * process being killed by its own build.
     */
    claim: async (input) => {
      const buildId = buildRunIdKind.mint();
      const targets = targetsOf(input);
      if (
        !(await claimBuildRun({
          buildId,
          trigger: input.trigger,
          commitHash: getHeadCommit(),
          targets,
        }))
      ) {
        return null;
      }
      if (input.trigger === "auto") await notifyBuildStarted(buildId, targets);
      return buildId;
    },
  },

  argv: (input, runId) => {
    const targets = targetsOf(input);
    // `--allow-main` stays BEFORE `--composition`: commander's variadic option
    // is greedy up to the next flag, so a flag placed after it would be
    // swallowed as another composition id.
    const argv = ["./singularity", "build", "--allow-main"];
    if (!isMainCompositionBuild(targets))
      argv.push("--composition", ...targets);
    return {
      argv,
      cwd: REPO_ROOT,
      // ADDED to this backend's environment, never a replacement for it: the
      // CLI needs the declared runtime environment the backend was started
      // with (`launcher/core` — PATH, HOME, the data root and the other
      // installation settings), plus these two. That environment is a closed
      // list, so spreading it hands the build no stray session state.
      //
      // SINGULARITY_BUILD_DETACHED is load-bearing: the CLI's orphan guard
      // exits a command whose invoking shell dies, and a supervised build is
      // MEANT to outlive the backend it restarts. (It is also what keeps the
      // build out of the admission valve's background lane.)
      envOverrides: {
        SINGULARITY_BUILD_ID: runId,
        SINGULARITY_BUILD_DETACHED: "1",
      },
    };
  },

  // `terminal` is deliberately unread: the row is already stamped with the
  // outcome by `closeRow` (or by the CLI itself, ~100s earlier), and the bell
  // describes the row rather than this call's view of it.
  onEnded: (runId) => onBuildEnded(runId),
});

/**
 * The commit this checkout is on, stamped onto the ledger row a build claims.
 *
 * FULL sha, deliberately. `build_runs.commitHash` is compared against the dist's
 * `.build-commit` and against the checkout's HEAD — both full — to decide
 * whether a target has already been attempted, and an abbreviated form makes
 * that comparison silently always-false. Every display of the column truncates
 * at render, which is where truncation belongs.
 */
export function getHeadCommit(): string | null {
  const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
  });
  if (proc.exitCode !== 0) return null;
  return proc.stdout.toString().trim() || null;
}
