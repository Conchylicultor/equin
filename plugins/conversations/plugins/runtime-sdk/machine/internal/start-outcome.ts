/**
 * How an agent's start looked at the end of the launch's wait:
 * - `ready` — the agent answers on its socket;
 * - `slow` — it does not answer yet (still coming up, or the wait was called
 *   off);
 * - `consumer-behind` — it answers, but this backend never applied its
 *   `started` line: the agent has written past the row's cursor.
 */
export type StartOutcome =
  | { kind: "ready" }
  | { kind: "slow" }
  | { kind: "consumer-behind"; cursorSeq: number; agentSeq: number };

/**
 * Decide the outcome from the one `hello` asked at the end of the wait.
 * `applied`: the consumer applied this start's `started` line in time.
 * `agentSeq`: the seq the agent answered with, null when it did not answer.
 * `cursorSeq`: the row's cursor after the wait.
 */
export function startOutcome(s: {
  applied: boolean;
  agentSeq: number | null;
  cursorSeq: number;
}): StartOutcome {
  if (s.agentSeq === null) return { kind: "slow" };
  // Applied: the cursor is past `started`; the agent having written more since
  // is ordinary lag, not a stall.
  if (s.applied || s.agentSeq <= s.cursorSeq) return { kind: "ready" };
  return {
    kind: "consumer-behind",
    cursorSeq: s.cursorSeq,
    agentSeq: s.agentSeq,
  };
}
