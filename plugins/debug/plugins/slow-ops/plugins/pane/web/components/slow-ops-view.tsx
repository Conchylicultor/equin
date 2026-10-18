import type { ReactElement } from "react";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  liveDataSource,
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

// How the derived fields present here (the collection declares their labels,
// types and filters; every sortable / filterable field's id IS its column).
const overrides = fieldOverrides(slowOpsList, {
  operationKind: {
    cell: (r) => (
      <Badge variant="muted" mono>
        {r.operationKind}
      </Badge>
    ),
    width: "7rem",
  },
  // The operation, plus a deep link to the newest sample's trace when the
  // engine admitted one (`lastTraceId`, derived server-side).
  operation: {
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
    width: "minmax(0,1fr)",
  },
  count: { align: "end", width: "4rem" },
  totalMs: {
    cell: (r) => <span className="tabular-nums">{ms(r.totalMs)}</span>,
    align: "end",
    width: "5.5rem",
  },
  waitMs: {
    cell: (r) => <span className="tabular-nums">{ms(r.waitMs)}</span>,
    align: "end",
    width: "5.5rem",
  },
  maxMs: {
    cell: (r) => <span className="tabular-nums">{ms(r.maxMs)}</span>,
    align: "end",
    width: "5rem",
  },
  lastMs: {
    cell: (r) => <span className="tabular-nums">{ms(r.lastMs)}</span>,
    align: "end",
    width: "5rem",
  },
  lastSeenAt: {
    cell: (r) => <RelativeTime date={r.lastSeenAt} />,
    align: "end",
    width: "7rem",
  },
});

// The Aggregates tab: every slow op of this worktree, ranked by total time and
// paged from the server. Opening a row shows its callers, waits, variants,
// measures and recent samples in the detail pane.
export function SlowOpsView(): ReactElement {
  const openPane = useOpenPane();
  const selectedId = slowOpDetailPane.useRouteEntry()?.params.id;
  return (
    <DataView<SlowOpListRow>
      overrides={overrides}
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
