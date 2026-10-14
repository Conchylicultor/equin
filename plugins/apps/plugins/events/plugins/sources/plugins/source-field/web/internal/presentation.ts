import { useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { mapResource } from "@plugins/primitives/plugins/live-state/web";
import {
  FieldPresentation,
  type LiveFieldOption,
  type LiveFieldOptionsRead,
} from "@plugins/network/plugins/live/web";
import {
  eventSources,
  eventsEntityRef,
  type EventSource,
} from "@plugins/apps/plugins/events/plugins/events-core/core";

/**
 * Every configured source as a `sourceId` option, named and sorted by name —
 * code-point order, as the server's `C` collation sorted them before.
 */
function sourceOptions(sources: readonly EventSource[]): LiveFieldOption[] {
  return [...sources]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((s) => ({ value: s.id, label: s.name }));
}

/**
 * The source dimension's options, read from the LIVE sources (the collection
 * is declared `all`, so every source is an option) — loading until they land,
 * never an empty option list. Its read's error surfaces on the Sources
 * surface, the only place it is actionable.
 */
export function useSourceOptions(): LiveFieldOptionsRead {
  const sources = useLive(eventSources);
  return useMemo(() => mapResource(sources, sourceOptions), [sources]);
}

/**
 * An event's `sourceId` in every list of events: an option per live source.
 * Registered here, on the events entity, because only this plugin holds the
 * live source rows — the list derives the field and names no source.
 */
export const sourceIdPresentation = FieldPresentation.Register({
  owner: eventsEntityRef,
  fields: { sourceId: { useOptions: useSourceOptions } },
});
