import type {
  DeployPhase,
  DeployRun,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import type { RunningCommit } from "./running-commit";

/**
 * The legs of an `update`, in the order they run, as every surface names
 * them: `title` in full (the site page's strip), `short` where three must fit
 * one narrow line (the health report's site row).
 */
export const DEPLOY_PHASE_TITLES: ReadonlyArray<{
  id: DeployPhase;
  title: string;
  short: string;
}> = [
  { id: "converge", title: "Converge host", short: "Converge" },
  { id: "build", title: "Build bundle", short: "Build" },
  { id: "ship", title: "Ship & health-check", short: "Ship & check" },
];

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/**
 * What pressing Deploy would do now, in its label: Deploying… while a run is
 * in flight, Retry deploy after a failure, Deploy N commits while `main` is
 * ahead of what is running, Deploy for a site never deployed, else Redeploy.
 * The site page's button and the health report's site row both say it.
 */
export function deployLabelOf(
  run: Pick<DeployRun, "status"> | null,
  commit: RunningCommit,
): string {
  if (run?.status === "running") return "Deploying…";
  if (run?.status === "failed") return "Retry deploy";
  if (commit.kind === "known" && commit.behindMain > 0)
    return `Deploy ${plural(commit.behindMain, "commit")}`;
  if (run === null && commit.kind === "unknown") return "Deploy";
  return "Redeploy";
}
