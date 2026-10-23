import { createContext, useContext, type ReactNode } from "react";

/** A stand-in row: whether its block is still `writing`; null for a transcript line. */
const StreamingRowContext = createContext<boolean | null>(null);

/**
 * Marks the row below as a stand-in for a block of the message the agent is
 * writing; `writing` while that block is the message's newest (`StandIn`).
 */
export function StreamingRowProvider({
  writing,
  children,
}: {
  writing: boolean;
  children: ReactNode;
}) {
  return (
    <StreamingRowContext.Provider value={writing}>
      {children}
    </StreamingRowContext.Provider>
  );
}

/**
 * The row draws a block of the message the agent is still writing
 * (`StreamingMessage`), not a transcript line: its content is a prefix that
 * keeps growing — text to reveal at a steady pace, a tool input with fields
 * still missing.
 */
export function useStreamingRow(): boolean {
  return useContext(StreamingRowContext) !== null;
}

/**
 * The row's block may still grow: a stand-in for the message's newest block.
 * False once a later block has begun — the model finished this one, though
 * the transcript does not hold it yet — and for a transcript line.
 */
export function useBlockWriting(): boolean {
  return useContext(StreamingRowContext) === true;
}
