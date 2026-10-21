import { createContext, useContext, type ReactNode } from "react";

const StreamingRowContext = createContext(false);

/** Marks the rows below as stand-ins for blocks the agent is still writing. */
export function StreamingRowProvider({ children }: { children: ReactNode }) {
  return (
    <StreamingRowContext.Provider value={true}>
      {children}
    </StreamingRowContext.Provider>
  );
}

/**
 * The row draws a block the agent is still writing (`StreamingMessage`), not a
 * transcript line: its content is a prefix that keeps growing — text to reveal
 * at a steady pace, a tool input with fields still missing.
 */
export function useStreamingRow(): boolean {
  return useContext(StreamingRowContext);
}
