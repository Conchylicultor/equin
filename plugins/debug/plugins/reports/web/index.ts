import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { reportsPane, reportDetailPane } from "./panes";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Notifications } from "@plugins/shell/plugins/notifications/web";
import { fixReportAction } from "./components/report-investigate";

export { reportsPane, reportDetailPane } from "./panes";

export default {
  description:
    "Debug pane listing all recorded reports (including low-signal/noise crashes) with kind, source, count, noise flag, and linked task; and a report notification's Fix (the fix-report notification action), the detail pane's investigate launch.",
  contributions: [
    Pane.Register({ pane: reportsPane }),
    Pane.Register({ pane: reportDetailPane }),
    DebugApp.Sidebar({
      id: "reports",
      title: "Reports",
      icon: symbol("bug-report"),
      opens: { pane: reportsPane, params: {} },
    }),
    // A report notification's Fix (`action.kind: "fix-report"`).
    Notifications.Action(fixReportAction),
  ],
  slots: { reports: reportsPane, "report-detail": reportDetailPane },
} satisfies PluginDefinition;
