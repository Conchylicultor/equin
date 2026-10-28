import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { submitOutcomeReportTool } from "./internal/mcp-tools";
import { reportRequiredCapability } from "./internal/capability";
import { reportStopGate } from "./internal/stop-gate";
import { outcomeReportWatchSource } from "./internal/watch-source";
import { outcomeReportDigestAnnotation } from "./internal/annotation";

export default {
  description:
    "Outcome reports, desktop-only half: the submit_outcome_report MCP tool (gated on the report.required grant; it emits outcomeReport.submitted after the write), the capability's describe, the stop gate that keeps a report-required conversation from stopping before it reported, the `outcome-report` watch source (reported / asking) and the `report: …` digest words — an agent session's surface, which exists only on a host that runs agents (the submit measures the attempt from git).",
  contributions: [
    reportRequiredCapability,
    reportStopGate,
    ...outcomeReportWatchSource,
    outcomeReportDigestAnnotation,
  ],
  register: [submitOutcomeReportTool],
} satisfies MachinePluginDefinition;
