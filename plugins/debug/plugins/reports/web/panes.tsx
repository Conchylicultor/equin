import {
  Pane,
  PaneChrome,
  resolveRow,
  useOpenPane,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import {
  reportsList,
  reportsRootRoute,
  reportDetailRoute,
} from "@plugins/reports/core";
import { ReportsView } from "./components/reports-view";
import { ReportDetail } from "./components/report-detail";

// Panes are declared first so their types are known before the component
// bodies reference them. Component identifiers below are function
// declarations (hoisted), so the forward reference is safe at runtime.

export const reportsPane = Pane.define({
  title: "Reports",
  route: reportsRootRoute,
  app: debugApp,
  component: ReportsBody,
});

function useResolveReport({ reportId }: { reportId: string }): ResolveResult {
  // The by-id row read (`reports.list:rows`), whatever the report's age.
  return resolveRow(useLive(reportsList, { id: reportId }));
}

/** The report's kind once it is read; the pane falls back to "Report" until then. */
function useReportTitle({
  reportId,
}: {
  reportId: string;
}): string | undefined {
  const row = useLive(reportsList, { id: reportId });
  return row.status === "ready" && row.found ? row.row.kind : undefined;
}

export const reportDetailPane = Pane.define({
  route: reportDetailRoute,
  app: debugApp,
  title: { useText: useReportTitle, fallback: "Report" },
  component: ReportDetailBody,
  width: 480,
  useResolve: useResolveReport,
});

function ReportsBody() {
  const openPane = useOpenPane();
  const selectedId = reportDetailPane.useRouteEntry()?.params.reportId;

  return (
    <PaneChrome pane={reportsPane}>
      <ReportsView
        selectedId={selectedId}
        linkTo={(id) =>
          openPane.to(reportDetailPane, { reportId: id }, { mode: "push" })
        }
      />
    </PaneChrome>
  );
}

function ReportDetailBody() {
  return <ReportDetail />;
}
