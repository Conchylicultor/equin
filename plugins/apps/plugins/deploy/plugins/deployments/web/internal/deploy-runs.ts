import type { DeployRun } from "../../core";

/**
 * The states a deployment's last run can be in. `never` is its own state
 * rather than an absent value: "we have never deployed this" and "the last
 * deploy failed" are different things to be told — and because the backend
 * forgets its runs on restart, `never` also honestly covers "not since this
 * boot".
 */
export const RUN_STATES = [
  "never",
  "running",
  "succeeded",
  "failed",
  "needs-approval",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_STATE_OPTIONS: { value: RunState; label: string }[] = [
  { value: "never", label: "Not run" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "needs-approval", label: "Needs approval" },
];

export function runStateOf(run: DeployRun | undefined): RunState {
  return run?.status ?? "never";
}

/** The in-flight run on `serverId`, if any — regardless of which deployment. */
export function runningOnServer(
  runs: Record<string, DeployRun>,
  serverId: string,
): DeployRun | undefined {
  return Object.values(runs).find(
    (r) => r.status === "running" && r.serverId === serverId,
  );
}
