import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import type { ConvergenceDecision } from "./decide";

/** The one build a convergence pass runs, or none. */
export interface ConvergenceBuild {
  /** Every app it deploys, main's own first: one `build_runs` row's targets. */
  targets: string[];
  /** The build's `--composition` arguments (empty: a plain build of main's own app). */
  compositionArgs: string[];
}

/**
 * Every app the decision wants, built together: ONE build of the decided
 * HEAD — one slot, one `build_runs` row with all targets (main's own app
 * first, then the compositions in manifest order). A decision is of one
 * HEAD, so apps due at different commits are never in one pass: they are
 * successive passes. `null` when nothing is due.
 */
export function convergenceBuild(
  decision: Pick<ConvergenceDecision, "main" | "compositions">,
): ConvergenceBuild | null {
  const main = decision.main.kind === "build";
  const targets = [
    ...(main ? [MAIN_COMPOSITION_ID] : []),
    ...decision.compositions,
  ];
  if (targets.length === 0) return null;
  const plain = targets.length === 1 && main;
  return {
    targets,
    compositionArgs: plain ? [] : ["--composition", ...targets],
  };
}

/** How a manual retry of main's current commit is spelled, for the log. */
const MANUAL_RETRY =
  "retry it with Build (the action bar's build popover, or Debug → Builds) or `./equin build --allow-main` in main's checkout";

/**
 * What a pass that builds nothing says about the deployment — never
 * "converged" unless the served dist names the HEAD (2026-11-18: a killed and
 * a failed build of main were each logged "converged at <sha>: nothing to
 * build" while main still served the commit before). `level: "error"`: the
 * retries of a commit whose builds keep ending without a verdict are spent,
 * and nothing automatic will try it again — the run that spent them fails, so
 * the gateway files it (`main-deploy-failed`).
 */
export function describeNothingToBuild(
  decision: Pick<ConvergenceDecision, "main" | "head" | "served">,
): { level: "info" | "warn" | "error"; line: string } {
  const head = decision.head?.slice(0, 9) ?? "(no HEAD)";
  const served = decision.served.ok
    ? decision.served.commit.slice(0, 9)
    : `nothing nameable (${decision.served.reason})`;
  const main = decision.main;
  switch (main.kind) {
    case "converged":
      return { level: "info", line: `converged at ${head}: it is served` };
    case "auto-build-off":
      return {
        level: "info",
        line: `nothing to build at ${head}: auto-build is off for this checkout (serves ${served})`,
      };
    case "unknown":
      return {
        level: "info",
        line: `nothing to build at ${head}: no deployment to compare against it (serves ${served})`,
      };
    case "failed":
      return {
        level: "warn",
        line:
          `deploy of ${head} failed (${main.attempt.id}): still serves ${served}. ` +
          `A failed build is a verdict, so it is not retried automatically — the next push is the next attempt, or ${MANUAL_RETRY}`,
      };
    case "built":
      return {
        level: "warn",
        line:
          `${head} was built (${main.attempt.id}) but is not what is served (the dist names ${served}): ` +
          `not rebuilt automatically — ${MANUAL_RETRY}`,
      };
    case "retries-spent":
      return {
        level: "error",
        line:
          `deploy of ${head} ended without a verdict ${main.attempts.length} times in a row ` +
          `(${main.attempts.map((a) => a.id).join(", ")} — killed, interrupted or superseded): ` +
          `still serves ${served}, and it is not retried again automatically. ` +
          `Find what keeps ending its builds (memory, a shutdown), then ${MANUAL_RETRY}`,
      };
    case "build":
      // `convergenceBuild` returns a build whenever main wants one.
      throw new Error(
        "[converge] describeNothingToBuild called on a decision that wants a build",
      );
  }
}
