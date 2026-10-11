import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  eventEmissions,
  type EmissionListRow,
} from "@plugins/infra/plugins/events/core";
import {
  DataView,
  defineDataView,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
import type { FieldDef } from "@plugins/primitives/plugins/data-view/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { compactJson } from "../internal/format";
import { WhenText } from "./cells";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const EVENTS_VIEW = defineDataView("debug.queue.events");

// The emit() log as a live source. Event names are a facet (a grouping of the
// whole log); `match` is derived server-side from `matchedCount`.
const emissionsSource = liveDataSource(eventEmissions, {
  searchable: ["eventName"],
  facets: ["eventName"],
});

/** Debug → Queue's Events section: the capped ring of the last ~1000 emit() calls. */
export function EventsView({
  selectedId,
  linkTo,
}: {
  selectedId?: string;
  linkTo: (id: string) => LinkTarget;
}) {
  return (
    <DataView<EmissionListRow>
      storageKey={EVENTS_VIEW}
      fields={fields}
      views={["table", "list"]}
      defaultView="table"
      source={emissionsSource}
      searchPlaceholder="Search events…"
      selectedRowId={selectedId}
      rowActivation={(r) => linkTo(r.id)}
      emptyState={
        <>No emissions recorded yet. Emit an event to populate this log.</>
      }
    />
  );
}

/** How many triggers an emission reached: a destructive "unmatched" at zero. */
export function MatchedBadge({ count }: { count: number }) {
  return count === 0 ? (
    <Badge variant="destructive">unmatched</Badge>
  ) : (
    <Badge>
      {count} {count === 1 ? "trigger" : "triggers"}
    </Badge>
  );
}

const fields: FieldDef<EmissionListRow>[] = [
  {
    id: "emittedAt",
    label: "Time",
    type: "date",
    value: (r) => r.emittedAt,
    cell: (r) => <WhenText date={r.emittedAt} prefix="Emitted" />,
    sortable: true,
    filterable: true,
    width: "6rem",
  },
  {
    id: "eventName",
    label: "Event",
    type: "enum",
    value: (r) => r.eventName,
    cell: (r) => (
      <Text variant="code" title={r.eventName}>
        {r.eventName}
      </Text>
    ),
    primary: true,
    sortable: true,
    filterable: true,
    width: "minmax(8rem,16rem)",
  },
  {
    id: "matchedCount",
    label: "Matched",
    type: "int",
    value: (r) => r.matchedCount,
    cell: (r) => <MatchedBadge count={r.matchedCount} />,
    sortable: true,
    filterable: true,
    width: "max-content",
  },
  {
    // Filter-only: the Matched column already says it.
    id: "match",
    label: "Match",
    type: "enum",
    value: (r) => r.match,
    options: [
      { value: "matched", label: "Matched", variant: "success" },
      { value: "unmatched", label: "Unmatched", variant: "destructive" },
    ],
    sortable: false,
    filterable: true,
    visible: false,
  },
  {
    id: "payload",
    label: "Payload",
    type: "text",
    value: (r) => compactJson(r.payload),
    cell: (r) => (
      <Text variant="code" tone="muted">
        {compactJson(r.payload)}
      </Text>
    ),
    sortable: false,
    filterable: false,
    width: "minmax(0,1fr)",
  },
];
