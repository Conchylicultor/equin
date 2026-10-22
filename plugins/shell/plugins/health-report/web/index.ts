import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { HealthReport } from "./slots";

export { HealthReport } from "./slots";
export { HealthReportButton } from "./components/health-report-button";
export type {
  HealthInfo,
  HealthReportRow,
  HealthState,
  HealthStatus,
  InfoRow,
  StatusRow,
} from "../core";

export default {
  description:
    "Unified health report: one dot merging every HealthReport.Row contribution (critical > attention > unknown > ok, with a count of rows needing a look), opening a popover that lists info rows first, then status rows in a fixed order. Owns the slot and the HealthReportButton; knows no contributor.",
  contributions: [],
  slots: HealthReport,
} satisfies PluginDefinition;
