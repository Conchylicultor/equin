import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { reportsPane, reportDetailPane } from "./panes";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Notifications } from "@plugins/shell/plugins/notifications/web";
import { fixReportAction } from "./components/report-investigate";
import { ReportsSources } from "./slots";
import {
  AllReportsSource,
  FixedSource,
  PendingSource,
  RegressedSource,
  WebsiteVisitorsSource,
  WorklistSource,
} from "./components/reports-view";

export { reportsPane, reportDetailPane } from "./panes";

export default {
  description:
    "Debug pane listing all recorded reports (including low-signal/noise crashes) with kind, source, count, noise flag, fix status and linked task — a view bar of Worklist (open ∪ regressed) / Regressed / Fix pending / Fixed / Website visitors (errors pulled from deployed sites, source website-visitor, badged) / All; and a report notification's Fix (the fix-report notification action), the detail pane's investigate launch.",
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
    // The Reports pane's view bar: slices of the same reports by where they
    // stand against their fix (`./slots.ts`). The Worklist first — the default.
    ReportsSources({
      id: "worklist",
      title: "Worklist",
      icon: symbol("pending-actions"),
      views: ["table", "list"],
      component: WorklistSource,
    }),
    ReportsSources({
      id: "regressed",
      title: "Regressed",
      icon: symbol("replay"),
      views: ["table", "list"],
      component: RegressedSource,
    }),
    ReportsSources({
      id: "pending",
      title: "Fix pending",
      icon: symbol("schedule"),
      views: ["table", "list"],
      component: PendingSource,
    }),
    ReportsSources({
      id: "fixed",
      title: "Fixed",
      icon: symbol("check-circle"),
      views: ["table", "list"],
      component: FixedSource,
    }),
    ReportsSources({
      id: "website-visitors",
      title: "Website visitors",
      icon: symbol("public"),
      views: ["table", "list"],
      component: WebsiteVisitorsSource,
    }),
    ReportsSources({
      id: "all",
      title: "All",
      icon: symbol("bug-report"),
      views: ["table", "list"],
      component: AllReportsSource,
    }),
  ],
  slots: {
    reports: reportsPane,
    "report-detail": reportDetailPane,
    sources: ReportsSources,
  },
} satisfies PluginDefinition;
