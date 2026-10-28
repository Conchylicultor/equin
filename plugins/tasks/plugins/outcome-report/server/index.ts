import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { outcomeReportRowsServed } from "./internal/resource";
import { outcomeReportSubmitted } from "./internal/tables-events";

export {
  outcomeReportSubmitted,
  _outcomeReportSubmittedTriggers,
} from "./internal/tables-events";
export type { OutcomeReportSubmittedPayload } from "./internal/tables-events";

export default {
  portable: true,
  description:
    "Outcome reports: owns tasks_ext_outcome_report (one report per task — markdown body, the attempt's git-measured standing, an optional question with one-click answers), serves the outcome-reports lookup collection, and declares the outcomeReport.submitted event a submit emits. The submit_outcome_report MCP tool that writes it (visible only to conversations whose mandate grants report.required), its stop gate and its watch source are the machine half.",
  contributions: [...outcomeReportRowsServed.declare],
  register: [outcomeReportSubmitted],
} satisfies ServerPluginDefinition;
