import { Mandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { reportRequired } from "@plugins/tasks/plugins/outcome-report/plugins/capability/core";

export const OUTCOME_REPORT_TOOL = "submit_outcome_report";

/** How `report.required` reads in the agent's `## Mandate` section — what the
 * separate outcome-report instructions used to say. */
export const reportRequiredCapability = Mandate.Capability({
  cap: reportRequired,
  describe: () =>
    `You must finish with an outcome report: the user is not watching, so never ask questions mid-way — decide, or stop. Always end by calling \`${OUTCOME_REPORT_TOOL}\` (see its description) — you cannot stop before it. Your mandate's exit rule says whether you then close the conversation with \`exit_clean\` or end your turn and leave it open for review.`,
});
