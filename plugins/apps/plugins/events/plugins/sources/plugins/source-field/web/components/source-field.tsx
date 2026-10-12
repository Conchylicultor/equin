import { useMemo, type ReactNode } from "react";
import type {
  FieldDef,
  FieldExtensionProps,
} from "@plugins/primitives/plugins/data-view/web";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  eventSources,
  type SourcedEvent,
  type EventSource,
} from "@plugins/apps/plugins/events/plugins/events-core/core";

/** The `sourceId` enum field over the given source choices. */
function sourceFields(
  sources: readonly EventSource[],
): FieldDef<SourcedEvent>[] {
  return [
    {
      id: "sourceId",
      label: "Source",
      type: "enum",
      options: sources.map((s) => ({ value: s.id, label: s.name })),
      value: (e) => e.sourceId,
      // Grouping dimension, not searchable text: an id typed into the search
      // box should not match every event from that source.
      filterable: false,
    },
  ];
}

const NO_SOURCES: readonly EventSource[] = [];

// Stable (module-level), so the `select` re-runs only when the set changes.
// Code-point order, as the server's `C` collation sorted them before.
function byName(sources: readonly EventSource[]): readonly EventSource[] {
  return [...sources].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

/**
 * The `source` dimension of the events DataView, contributed into
 * `event-list`'s `EventList.Fields` seam.
 *
 * A component rather than plain data because the option list is hook-loaded:
 * only this plugin holds the live `event_sources` rows, and `FieldDef.value` is
 * a synchronous closure that cannot call hooks. Same shape as
 * `tasks/task-category`'s `CategoryField`.
 *
 * The options are every source (the collection is declared `all`), sorted by
 * name here.
 *
 * The field id is **`sourceId`**, matching the column the `events.list`
 * collection declares filterable and sortable — that is what makes filtering
 * and sorting by source compile to SQL with zero edits to `event-list`. A field
 * id naming no column of the collection is refused by the live source at mount.
 */
export function SourceField({
  render,
}: FieldExtensionProps<SourcedEvent>): ReactNode {
  const result = useLive(eventSources, { select: byName });
  // Every arm renders the SAME element at the same position: `render` wraps the
  // rest of the DataView, so a different tree per arm would remount the list
  // when the sources land. While they load (or if the read fails) the field
  // still exists — the Filter pill never appears and disappears — it just
  // offers no choices yet. The read's error surfaces on the Sources surface,
  // which is the only place it is actionable.
  return matchResource(result, {
    loading: () => <SourceOptions sources={NO_SOURCES} render={render} />,
    error: () => <SourceOptions sources={NO_SOURCES} render={render} />,
    ready: (sources) => <SourceOptions sources={sources} render={render} />,
  });
}

function SourceOptions({
  sources,
  render,
}: {
  sources: readonly EventSource[];
  render: FieldExtensionProps<SourcedEvent>["render"];
}): ReactNode {
  const fields = useMemo(() => sourceFields(sources), [sources]);
  return <>{render(fields)}</>;
}
