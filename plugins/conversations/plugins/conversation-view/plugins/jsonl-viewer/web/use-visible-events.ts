import { useMemo } from "react";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { JsonlViewer } from "./slots";

/**
 * The events the transcript actually renders: the raw resource minus everything
 * a `JsonlViewer.EventFilter` contributor hides.
 *
 * **Anything enumerating the transcript must go through this**, not the raw
 * resource. The two disagreed for a long time and it was invisible: the table of
 * contents listed messages off the unfiltered array while the rows were rendered
 * — and stamped with their positional index — from the filtered one, so in any
 * conversation where `ask-user-question` had hidden a `user-text` event the TOC
 * offered an entry with no row behind it and mis-numbered every entry after it.
 *
 * Consumers must not re-implement the predicate either: the filter set is an open
 * collection, so a plugin added later has to change every enumerator at once, and
 * that only happens if there is exactly one.
 */
export function useVisibleEvents(events: JsonlEvent[]): JsonlEvent[] {
  const filters = JsonlViewer.EventFilter.useContributions();
  return useMemo(
    () => events.filter((e) => !filters.some((f) => f.hide(e))),
    [events, filters],
  );
}
