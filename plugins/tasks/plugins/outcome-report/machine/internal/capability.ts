import { Mandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { reportRequired } from "@plugins/tasks/plugins/outcome-report/plugins/capability/core";

export const OUTCOME_REPORT_TOOL = "submit_outcome_report";

/** How `report.required` reads in the agent's `## Mandate` section — what the
 * separate outcome-report instructions used to say. */
export const reportRequiredCapability = Mandate.Capability({
  cap: reportRequired,
  describe: () =>
    `You must finish with an outcome report: the user is not watching, so never ask questions mid-way — decide, or stop. Always end by calling \`${OUTCOME_REPORT_TOOL}\` (see its description), then end your turn; you cannot stop before it. Do not call \`exit_clean\` on your own: the conversation stays open for review. Call it only when a person asks you to exit.`,
});
