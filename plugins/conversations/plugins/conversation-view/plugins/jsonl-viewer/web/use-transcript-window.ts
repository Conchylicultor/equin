import { useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  useCombinedResources,
  type PagedResourceResult,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { jsonlEvents, type TranscriptEventRow } from "../core";
import type { TranscriptOlder } from "./components/transcript-view";

/** The loaded tail of a conversation's transcript, oldest first. */
export interface TranscriptWindow {
  events: JsonlEvent[];
  /** Each event's row id, aligned with `events` (`TranscriptView`'s `ids`). */
  ids: string[];
  /** The seq of `events[0]`: how many events precede the window. */
  firstSeq: number;
  /** How to load what precedes it (`TranscriptView`'s `older`). */
  older: TranscriptOlder;
}

type Paging = Pick<TranscriptOlder, "canGrow" | "growing" | "loadMore">;

/** A paged read's handles — only its ready arm has any. */
function pagingOf(rows: PagedResourceResult<TranscriptEventRow>): Paging {
  switch (rows.status) {
    case "ready":
      return rows;
    case "loading":
    case "error":
      return { canGrow: false, growing: false, loadMore: () => {} };
  }
}

function windowOf(
  rows: readonly TranscriptEventRow[],
  paging: Paging,
  firstAssistantSeq: number | null,
): TranscriptWindow {
  // Newest first on the wire; drawn oldest first.
  const oldestFirst = [...rows].reverse();
  const firstSeq = oldestFirst[0]?.seq ?? 0;
  return {
    events: oldestFirst.map((r) => r.event),
    ids: oldestFirst.map((r) => r.id),
    firstSeq,
    older: {
      canGrow: paging.canGrow,
      growing: paging.growing,
      loadMore: paging.loadMore,
      answeredBefore:
        firstAssistantSeq !== null && firstAssistantSeq < firstSeq,
    },
  };
}

/**
 * A conversation's transcript as the page reads it: its latest events, older
 * ones loading on `older.loadMore()` — never the whole array at once, which on
 * a long conversation is megabytes per change.
 *
 * A tail window is CLOSED UNDER "after": every event after a loaded one is
 * loaded. So a reader that scans forward from an event it holds (an
 * AskUserQuestion card finding its answer) sees all it would in the whole
 * transcript; one that needs the whole conversation (an outline, a total)
 * reads its own server-side value instead.
 */
export function useTranscriptWindow(
  conversationId: string,
  options?: {
    /**
     * Events in the first page (default: one page). A surface that draws a
     * conversation whole and cannot scroll back (an embedded thread) asks for
     * `jsonlEvents`' ceiling at once.
     */
    limit?: number;
  },
): ResourceResult<TranscriptWindow> {
  const rows = useLive(
    jsonlEvents,
    { id: conversationId },
    options?.limit === undefined ? undefined : { limit: options.limit },
  );
  const meta = useLive(jsonlEvents.meta, { id: conversationId });
  // The window is drawn once both have landed: which folds open the session
  // depends on whether the agent answered before the window (the meta).
  const both = useCombinedResources({ rows, meta });
  return useMemo(
    () =>
      mapResource(both, (data) =>
        windowOf(data.rows, pagingOf(rows), data.meta.firstAssistantSeq),
      ),
    [both, rows],
  );
}
