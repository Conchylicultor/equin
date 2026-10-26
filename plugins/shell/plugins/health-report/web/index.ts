import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { HealthReport } from "./slots";
import { HealthReportButton } from "./components/health-report-button";

export { HealthReport } from "./slots";
export type {
  HealthInfo,
  HealthMark,
  HealthReportRow,
  HealthState,
  HealthStatus,
  InfoRow,
  StatusRow,
} from "../core";

export default {
  description:
    "Unified health report: one dot merging every HealthReport.Row contribution (critical > attention > unknown > ok, with a count of rows needing a look), opening a popover that lists info rows first, then status rows in the slot's reorder layout order. Owns the slot, and contributes its button as the action bar's leading mark (ActionBar.Lead); knows no contributor.",
  contributions: [
    // The bar's always-visible leading mark. A companion of the bar, so it
    // ships wherever the bar does.
    ActionBar.Lead({
      id: "health-report",
      component: HealthReportButton,
      companion: true,
    }),
  ],
  slots: HealthReport,
} satisfies PluginDefinition;
