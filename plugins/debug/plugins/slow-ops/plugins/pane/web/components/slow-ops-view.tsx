import type { ReactElement } from "react";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  DataView,
  defineDataView,
  liveDataSource,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { appLink } from "@plugins/apps-core/plugins/tabs/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { traceDetailRoute } from "@plugins/debug/plugins/trace/plugins/engine/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  slowOpsList,
  type SlowOpListRow,
} from "@plugins/debug/plugins/slow-ops/core";
import { slowOpDetailPane } from "../panes";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const SLOW_OPS_LOCAL = defineDataView("debug.slow-ops.local");

// The live source: the `slow-ops.ops` window, read as a scroll ranked by total
// time. Sort / filter / search compile to SQL server-side, and a new slow
// occurrence reaches the window through the recorder's change producer (one
// flush per 2 s) — no Refresh. The Kind filter's options are a facet: a
// grouping of the whole table, not the loaded rows.
const opsSource = liveDataSource(slowOpsList, {
  searchable: ["operation"],
  facets: ["operationKind"],
});

const ms = (v: number): string => `${Math.round(v)}`;

const boltIcon = symbol("bolt");

// Static: every sortable / filterable field's id IS its collection column.
const fields: FieldDef<SlowOpListRow>[] = [
  {
    id: "operationKind",
    label: "Kind",
    type: "enum",
    value: (r) => r.operationKind,
    cell: (r) => (
      <Badge variant="muted" mono>
        {r.operationKind}
      </Badge>
    ),
    sortable: false,
    filterable: true,
    width: "7rem",
  },
  {
    id: "operation",
    label: "Operation",
    type: "text",
    primary: true,
    value: (r) => r.operation,
    // The operation, plus a deep link to the newest sample's trace when the
    // engine admitted one (`lastTraceId`, derived server-side).
    cell: (r) => (
      <Stack
        direction="row"
        gap="xs"
        align="center"
        className={yieldClass("x")}
      >
        <Text
          as="span"
          variant="caption"
          className="truncate font-mono"
          title={r.operation}
        >
          {r.operation}
        </Text>
        {r.lastTraceId && (
          <LinkChip
            leading={<Icon icon={boltIcon} className="icon-auto" />}
            activation={appLink(
              traceDetailRoute.link(debugApp, { id: r.lastTraceId }),
            )}
          >
            trace
          </LinkChip>
        )}
      </Stack>
    ),
    sortable: false,
    filterable: true,
    width: "minmax(0,1fr)",
  },
  {
    id: "count",
    label: "Count",
    type: "number",
    value: (r) => r.count,
    sortable: true,
    filterable: true,
    align: "end",
    width: "4rem",
  },
  {
    id: "totalMs",
    label: "Total (ms)",
    type: "number",
    value: (r) => r.totalMs,
    cell: (r) => <span className="tabular-nums">{ms(r.totalMs)}</span>,
    sortable: true,
    filterable: true,
    align: "end",
    width: "5.5rem",
  },
  {
    id: "waitMs",
    label: "Wait (ms)",
    type: "number",
    value: (r) => r.waitMs,
    cell: (r) => <span className="tabular-nums">{ms(r.waitMs)}</span>,
    sortable: true,
    filterable: false,
    align: "end",
    width: "5.5rem",
  },
  {
    id: "maxMs",
    label: "Max (ms)",
    type: "number",
    value: (r) => r.maxMs,
    cell: (r) => <span className="tabular-nums">{ms(r.maxMs)}</span>,
    sortable: true,
    filterable: false,
    align: "end",
    width: "5rem",
  },
  {
    id: "lastMs",
    label: "Last (ms)",
    type: "number",
    value: (r) => r.lastMs,
    cell: (r) => <span className="tabular-nums">{ms(r.lastMs)}</span>,
    sortable: true,
    filterable: false,
    align: "end",
    width: "5rem",
  },
  {
    id: "lastSeenAt",
    label: "Last seen",
    type: "date",
    value: (r) => r.lastSeenAt,
    cell: (r) => <RelativeTime date={r.lastSeenAt} />,
    sortable: true,
    filterable: true,
    align: "end",
    width: "7rem",
  },
];

// The Aggregates tab: every slow op of this worktree, ranked by total time and
// paged from the server. Opening a row shows its callers, waits, variants,
// measures and recent samples in the detail pane.
export function SlowOpsView(): ReactElement {
  const openPane = useOpenPane();
  const selectedId = slowOpDetailPane.useRouteEntry()?.params.id;
  return (
    <DataView<SlowOpListRow>
      fields={fields}
      source={opsSource}
      storageKey={SLOW_OPS_LOCAL}
      views={["table", "list"]}
      defaultView="table"
      selectedRowId={selectedId}
      rowActivation={(r) =>
        openPane.to(slowOpDetailPane, { id: r.id }, { mode: "push" })
      }
      emptyState="No slow operations recorded"
    />
  );
}
