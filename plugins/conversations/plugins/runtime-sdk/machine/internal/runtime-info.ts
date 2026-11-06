import type { RuntimeInfo } from "@plugins/conversations/server";
import type { AgentProjection } from "../../server/internal/reducer";

// What the sdk runtime tells the status reconciler about one agent, derived
// from its projection — the ONE derivation both `inspect` (what it answers)
// and the events consumer (whether to signal) read, so the consumer signals
// exactly when the answer would differ.

/** The live state `inspect` reports for an agent at this projection. */
export function infoOf(p: AgentProjection): RuntimeInfo {
  return {
    workingOn: p.working ? "turn" : p.backgroundTasks > 0 ? "background" : null,
    dead: false,
    claudeSessionId: p.sessionId,
    statusWrittenAt: p.statusAt,
  };
}

/**
 * Whether moving from `prev` to `next` changes anything the reconciler can
 * see through the runtime: the reported info, or the agent process itself (a
 * start or an exit — liveness is the pid file's, but the lines announcing it
 * are what move the projection's pid).
 *
 * Most event lines (assistant text, tool calls and results) change none of
 * it: they advance the cursor only, and a reconcile for them would re-read the
 * rows to plan a no-op. What the side effects of those lines move (the turn
 * ledger, the question holds) signals the reconciler from its own store.
 */
export function reportedStateChanged(
  prev: AgentProjection,
  next: AgentProjection,
): boolean {
  if (prev.agentPid !== next.agentPid) return true;
  const a = infoOf(prev);
  const b = infoOf(next);
  // Every field, so one added to RuntimeInfo is compared without a word here.
  return (Object.keys(a) as (keyof RuntimeInfo)[]).some(
    (key) => !sameValue(a[key], b[key]),
  );
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  return a === b;
}
