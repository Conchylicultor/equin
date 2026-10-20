import { createContext, useContext, type ReactNode } from "react";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

export interface TranscriptRead {
  /**
   * The transcript from its start up to the last row the reader can see —
   * the raw resource array, NOT the filtered one, so a stat can still read the
   * very events it hides from the flow (that is the point of moving a fact out
   * of the rows and into the strip).
   */
  events: JsonlEvent[];
  /**
   * The seq of `events[0]`: how many events precede it that the page does not
   * hold (a conversation opens on its latest events). A stat folds them through
   * `useTranscriptFold`, never by reading `events` alone.
   */
  firstSeq: number;
  /** True while the strip is describing the whole transcript (scrolled to the end). */
  atEnd: boolean;
}

const TranscriptReadContext = createContext<TranscriptRead | null>(null);

export function TranscriptReadProvider({
  value,
  children,
}: {
  value: TranscriptRead;
  children: ReactNode;
}) {
  return (
    <TranscriptReadContext.Provider value={value}>
      {children}
    </TranscriptReadContext.Provider>
  );
}

/**
 * The transcript as far as the reader has scrolled. Only valid inside a
 * `TranscriptStats.Item` contribution — a stat rendered anywhere else has no
 * reading position to fold over, which is a wiring mistake, not a state to
 * render around.
 */
export function useTranscriptRead(): TranscriptRead {
  const value = useContext(TranscriptReadContext);
  if (!value) {
    throw new Error(
      "useTranscriptRead must be used inside a TranscriptStats.Item contribution",
    );
  }
  return value;
}
