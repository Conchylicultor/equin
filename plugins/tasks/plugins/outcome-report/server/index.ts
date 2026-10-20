import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { outcomeReportRowsServed } from "./internal/resource";

export default {
  portable: true,
  description:
    "Outcome reports for automated tasks: owns tasks_ext_outcome_report (one report per task — markdown body, the attempt's git-measured standing, an optional question with one-click answers) and serves the outcome-reports lookup collection. The submit_outcome_report MCP tool that writes it (visible only to conversations whose task an automation filed or launched; it releases the task's automation slot and rings the bell when a question waits) is the machine half.",
  contributions: [...outcomeReportRowsServed.declare],
} satisfies ServerPluginDefinition;
