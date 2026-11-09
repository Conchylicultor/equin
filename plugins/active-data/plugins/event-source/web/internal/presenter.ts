import { useLive } from "@plugins/network/plugins/live/web";
import {
  paneTarget,
  type PaneTarget,
} from "@plugins/primitives/plugins/pane/web";
import { rowReferent } from "@plugins/active-data/plugins/id-chip/web";
import { eventSources } from "@plugins/apps/plugins/events/plugins/events-core/core";
import { eventSourceDetailPane } from "@plugins/apps/plugins/events/plugins/sources/web";
import type { IdReferentState } from "@plugins/ids/web";

/** An event source's chip title — its name — from the by-id row read. */
export function useEventSourceReferent(id: string): IdReferentState {
  return rowReferent(useLive(eventSources, { id }), (s) => s.name);
}

/** The source's detail pane. */
export function useEventSourcePane(id: string): PaneTarget {
  return paneTarget(eventSourceDetailPane, { sourceId: id });
}
