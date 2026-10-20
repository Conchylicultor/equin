import { createContext, useContext, type ReactNode } from "react";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

const TranscriptEventsContext = createContext<JsonlEvent[] | null>(null);

export function TranscriptEventsProvider({
  events,
  children,
}: {
  events: JsonlEvent[];
  children: ReactNode;
}) {
  return (
    <TranscriptEventsContext.Provider value={events}>
      {children}
    </TranscriptEventsContext.Provider>
  );
}

/**
 * The transcript the enclosing `TranscriptView` is drawing — unfiltered, and
 * already arrived (the view is only mounted with data).
 *
 * This is what a `JsonlViewer.Overlay` contribution folds over, rather than
 * subscribing to a transcript by conversation id: the view is not always the
 * conversation's own (a sub-agent's pane draws the sub-agent's transcript under
 * the PARENT conversation id), so re-fetching by id would annotate the wrong
 * transcript. Reading what the view draws makes that mismatch inexpressible.
 */
export function useTranscriptEvents(): JsonlEvent[] {
  const value = useContext(TranscriptEventsContext);
  if (!value) {
    throw new Error(
      "useTranscriptEvents must be used inside a TranscriptView (e.g. a JsonlViewer.Overlay contribution)",
    );
  }
  return value;
}
