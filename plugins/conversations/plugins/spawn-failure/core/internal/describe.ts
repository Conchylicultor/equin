import type { SpawnFailure, SpawnStep } from "./schemas";

const STEP_LABELS: Record<SpawnStep, string> = {
  worktree: "Preparing the workspace failed",
  runtime: "Starting the agent session failed",
};

/** The label every surface shows for a gone conversation whose launch failed. */
export const FAILED_TO_START_LABEL = "Failed to start";

/** One sentence saying which step failed and why, for a tooltip or a detail line. */
export function describeSpawnFailure(failure: SpawnFailure): string {
  return `${STEP_LABELS[failure.step]}: ${failure.message}`;
}
