import { useLiveRow } from "@plugins/network/plugins/live/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { rowReferent } from "@plugins/active-data/plugins/id-chip/web";
import { eventSources } from "@plugins/apps/plugins/events/plugins/events-core/core";
import { eventSourceDetailPane } from "@plugins/apps/plugins/events/plugins/sources/web";
import type { IdReferentState } from "@plugins/ids/web";

/** An event source's chip title — its name — from the by-id row read. */
export function useEventSourceReferent(id: string): IdReferentState {
  return rowReferent(useLiveRow(eventSources, id), (s) => s.name);
}

/** The link to the source's detail pane beside the surface holding the id (`push`). */
export function useEventSourceTarget(): (id: string) => LinkTarget {
  const openPane = useOpenPane();
  return (id) =>
    openPane.to(eventSourceDetailPane, { sourceId: id }, { mode: "push" });
}
