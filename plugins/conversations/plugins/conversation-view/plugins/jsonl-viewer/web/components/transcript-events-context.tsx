import { createContext, useContext, type ReactNode } from "react";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type { TranscriptOlder } from "./transcript-view";

/** What the enclosing `TranscriptView` draws. */
export interface TranscriptEvents {
  /** The events drawn — unfiltered. A window's events, oldest first, when `older` is set. */
  events: JsonlEvent[];
  /**
   * The seq of `events[0]` in the whole transcript: how many events precede
   * what is drawn (0 for a whole transcript).
   */
  firstSeq: number;
  /** Set when the view draws a window of a longer transcript (older events load on scroll). */
  older: TranscriptOlder | null;
  /**
   * Seek into the older part of a window (null for a whole transcript): while
   * on, the view sits at its top and keeps loading older pages, instead of
   * holding the reader's place as each lands. A jump to an event not loaded
   * yet turns it on, and off once the event's row has mounted.
   */
  seekOlder: ((seeking: boolean) => void) | null;
}

const TranscriptEventsContext = createContext<TranscriptEvents | null>(null);

export function TranscriptEventsProvider({
  value,
  children,
}: {
  value: TranscriptEvents;
  children: ReactNode;
}) {
  return (
    <TranscriptEventsContext.Provider value={value}>
      {children}
    </TranscriptEventsContext.Provider>
  );
}

function useTranscriptEventsContext(): TranscriptEvents {
  const value = useContext(TranscriptEventsContext);
  if (!value) {
    throw new Error(
      "useTranscriptEvents must be used inside a TranscriptView (e.g. a JsonlViewer.Overlay contribution)",
    );
  }
  return value;
}

/**
 * The transcript the enclosing `TranscriptView` is drawing — unfiltered, and
 * already arrived (the view is only mounted with data). On a long
 * conversation that is its LATEST events (`useTranscriptDrawn().older`): a
 * reader of the whole conversation reads its own server-side value instead.
 *
 * This is what a `JsonlViewer.Overlay` contribution folds over, rather than
 * subscribing to a transcript by conversation id: the view is not always the
 * conversation's own (a sub-agent's pane draws the sub-agent's transcript under
 * the PARENT conversation id), so re-fetching by id would annotate the wrong
 * transcript. Reading what the view draws makes that mismatch inexpressible.
 */
export function useTranscriptEvents(): JsonlEvent[] {
  return useTranscriptEventsContext().events;
}

/** What the enclosing `TranscriptView` draws, with where it sits in the transcript. */
export function useTranscriptDrawn(): TranscriptEvents {
  return useTranscriptEventsContext();
}
