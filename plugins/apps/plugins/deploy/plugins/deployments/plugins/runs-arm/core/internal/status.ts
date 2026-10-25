import type { RunOutcome } from "@plugins/runs/plugins/run-outcome/core";
import type { DEPLOY_RUN_STATUSES } from "@plugins/apps/plugins/deploy/plugins/deployments/core";

/**
 * Every value `deploy_runs.status` can hold, and the shared outcome each means.
 *
 * The mapping happens to be one-to-one, which is exactly why it is written down
 * rather than passing the column straight through. The union validates each
 * row's outcome against the closed vocabulary, so a status added to `deploy_runs`
 * and not mapped here would leak an invalid outcome into the page — silently, if
 * it were a passthrough. As a `Record<DeployRunStatus, RunOutcome>` folded into
 * the `CASE`, the branch set IS the status set and an unmapped one is a `tsc`
 * error.
 *
 * `running` is a legitimate row to read back and sometimes a stale one: a
 * backend that died mid-run leaves it, because the process that would have
 * stamped an outcome is the one that went away. Reading `running` is the honest
 * record of that; nothing here invents a terminal status nobody observed.
 */
export const DEPLOY_STATUS_OUTCOME = {
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  "needs-approval": "needs-approval",
} as const satisfies Record<(typeof DEPLOY_RUN_STATUSES)[number], RunOutcome>;

export type DeployRunStatus = keyof typeof DEPLOY_STATUS_OUTCOME;
