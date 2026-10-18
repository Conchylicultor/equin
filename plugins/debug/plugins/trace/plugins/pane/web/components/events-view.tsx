import { useMemo, type ReactElement } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import {
  traceEvents,
  type TraceListItem,
} from "@plugins/debug/plugins/trace/plugins/engine/core";
import { triggerVariant } from "../internal/trigger-meta";
import { groupIncidents } from "../internal/incidents";
import { IncidentBadge } from "./incident-badge";
import { traceDetailPane } from "../panes";

const NO_ROWS: TraceListItem[] = [];

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const TRACE_EVENTS = defineDataView("debug.trace.events");

// The Events tab: the 200 newest slow-event traces (metadata only — no
// snapshot blob), read live from the `debug.traces` window. `traces` has no
// change-feed trigger (a trace is written exactly when the system is slow); its
// in-process change producer routes each insert, coalesced to one flush per
// 2 s, so a new trace reaches the open list without a per-write cascade.
// Incident grouping runs over the whole loaded window, so the DataView gets
// the rows locally. Row activate opens the detail Gantt.
export function EventsView(): ReactElement {
  const openPane = useOpenPane();
  const result = useLive(traceEvents);
  const selectedId = traceDetailPane.useRouteEntry()?.params.id;

  // The DataView renders the loading and failed states (`readiness`); only a
  // ready read's rows reach the view.
  const rows = foldResource(result, {
    loading: () => NO_ROWS,
    error: () => NO_ROWS,
    ready: (d) => d,
  });
  const incidents = useMemo(() => groupIncidents(rows), [rows]);

  // What the list computes itself, from the loaded window: the incident a
  // trace belongs to, and how far over its budget it ran.
  const extraFields = useMemo<FieldDef<TraceListItem>[]>(
    () => [
      {
        id: "incident",
        label: "Incident",
        type: "number",
        align: "start",
        // Co-occurrence count (≥1); solo traces render nothing in the cell so the
        // column is noise-free, but the value stays numerically meaningful.
        value: (r) => incidents.get(r.id)?.size ?? 1,
        cell: (r) => {
          const info = incidents.get(r.id);
          return info && info.size > 1 ? (
            <IncidentBadge info={info} windowSpanMs={r.windowSpanMs} />
          ) : null;
        },
        width: "4rem",
      },
      {
        id: "overBudget",
        label: "Over budget",
        type: "number",
        value: (r) => (r.thresholdMs > 0 ? r.durationMs / r.thresholdMs : 0),
        cell: (r) =>
          r.thresholdMs > 0 ? (
            <span className="font-mono tabular-nums text-muted-foreground">
              ×{(r.durationMs / r.thresholdMs).toFixed(1)}
            </span>
          ) : null,
        align: "end",
        sortable: true,
        width: "6rem",
      },
    ],
    [incidents],
  );

  return (
    <DataView<TraceListItem>
      rows={rows}
      collection={traceEvents}
      overrides={overrides}
      extraFields={extraFields}
      rowKey={(r) => r.id}
      storageKey={TRACE_EVENTS}
      views={["table", "list"]}
      defaultView="table"
      readiness={result}
      selectedRowId={selectedId}
      rowActivation={(r) =>
        openPane.to(traceDetailPane, { id: r.id }, { mode: "push" })
      }
      emptyState="No slow-event traces recorded yet."
    />
  );
}

// How the derived fields present here (the collection declares their labels,
// types and filters; the Trigger options are the presentation's).
const overrides = fieldOverrides(traceEvents, {
  createdAt: {
    cell: (r) => (
      <span className="text-muted-foreground">
        <RelativeTime date={r.createdAt} />
      </span>
    ),
    width: "7rem",
  },
  triggerKind: {
    cell: (r) => (
      <Badge variant={triggerVariant(r.triggerKind)} mono>
        {r.triggerKind}
      </Badge>
    ),
    width: "9rem",
  },
  triggerLabel: {
    cell: (r) => (
      <Text
        as="span"
        variant="caption"
        className="truncate font-mono"
        title={r.triggerLabel}
      >
        {r.triggerLabel}
      </Text>
    ),
    width: "minmax(0,1fr)",
  },
  durationMs: {
    cell: (r) => (
      <span className="font-mono tabular-nums">
        {Math.round(r.durationMs)} ms
      </span>
    ),
    align: "end",
    width: "6rem",
  },
});
