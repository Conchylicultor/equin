import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  outcomeReportInstructions,
  submitOutcomeReportTool,
} from "./internal/mcp-tools";

export default {
  description:
    "Outcome reports, desktop-only half: the submit_outcome_report MCP tool and its instructions — an agent session's MCP surface, which exists only on a host that runs agents (the submit measures the attempt from git).",
  register: [submitOutcomeReportTool, outcomeReportInstructions],
} satisfies MachinePluginDefinition;
