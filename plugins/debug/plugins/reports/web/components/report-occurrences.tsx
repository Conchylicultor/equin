import type { ReactElement } from "react";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { TabOriginBadge } from "@plugins/apps-core/plugins/tab-origin/web";
import type { Report, ReportOccurrence } from "@plugins/reports/core";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const REPORT_OCCURRENCES_VIEW = defineDataView("debug.report-occurrences");

const FIELDS: FieldDef<ReportOccurrence>[] = [
  {
    id: "at",
    label: "When",
    type: "date",
    value: (o) => new Date(o.at),
    cell: (o) => (
      <Text variant="caption" tone="muted" className="tabular-nums">
        <RelativeTime date={new Date(o.at)} />
      </Text>
    ),
    sortable: true,
    width: "5rem",
  },
  {
    id: "message",
    label: "Message",
    type: "text",
    primary: true,
    value: (o) => o.message,
    cell: (o) => (
      <Text variant="caption" className="truncate" title={o.message}>
        {o.message}
      </Text>
    ),
    width: "minmax(0,1fr)",
  },
  {
    id: "tab",
    label: "Tab",
    type: "text",
    value: (o) => o.clientId ?? "",
    cell: (o) => (
      <TabOriginBadge stamp={{ clientId: o.clientId, url: o.url }} />
    ),
    width: "11rem",
  },
];

/**
 * A report's newest occurrences (`report.recent`), each with what it said and
 * which tab raised it — what a repeat overwrites on the row itself. Older
 * occurrences age out; `count` still counts them all.
 */
export function ReportOccurrences({
  report,
}: {
  report: Report;
}): ReactElement {
  return (
    <DataView<ReportOccurrence>
      rows={report.recent}
      fields={FIELDS}
      rowKey={(o) => `${o.at}:${o.clientId ?? ""}`}
      storageKey={REPORT_OCCURRENCES_VIEW}
      views={["table", "list"]}
      defaultView="table"
      emptyState="No occurrence recorded yet."
    />
  );
}
