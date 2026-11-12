import { Mandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { reportRequired } from "@plugins/tasks/plugins/outcome-report/plugins/capability/core";

export const OUTCOME_REPORT_TOOL = "submit_outcome_report";

/** How `report.required` reads in the agent's `## Mandate` section: only
 * what the tool and the stop gate do not say — that nobody is watching. The
 * tool's description and the stop gate carry "end with the report". */
export const reportRequiredCapability = Mandate.Capability({
  cap: reportRequired,
  describe: () =>
    `The user is not watching: never ask questions mid-way — decide, or stop. End with \`${OUTCOME_REPORT_TOOL}\`.`,
});
