import {
  StopWaiver,
  type StopWaiverEntry,
} from "@plugins/conversations/plugins/stop-gate/server";
import { isSdkConversation } from "../../server/internal/rows";
import { currentAgentRow } from "./agent-row-lease";
import { catchUpWithin } from "./consumer";

// An agent with background work in flight may end its turn: each of those
// tasks re-invokes it when it finishes, so stopping is how it waits — the one
// legal way, since watching the work in the foreground is a poll loop the
// guards refuse. Without this, a stop gate (an outcome report owed) refused
// that stop too, and the agent had no way left to wait at all (2026-11-15).

/**
 * How long the waiver lets the consumer apply what the agent has written
 * before reading its count — far inside the hook's own give-up (15 s).
 */
const CATCH_UP_BUDGET_MS = 5_000;

/** What the agent reads, on a blocked stop, about this way of stopping. */
export const BACKGROUND_WORK_WHEN =
  "you have background work running that will wake you when it finishes — a command started with `run_in_background: true` (an `./equin` build, push or run included), a Monitor, a background subagent or a workflow. Start what you are waiting for that way and end your turn; never watch it in the foreground";

/** The waiver over a reader of the agent's in-flight background task count (null: not an sdk agent). */
export function backgroundWorkWaiver(
  backgroundTasksOf: (conversationId: string) => Promise<number | null>,
): StopWaiverEntry {
  return {
    id: "background-work",
    when: BACKGROUND_WORK_WHEN,
    async waives(conversationId) {
      const count = await backgroundTasksOf(conversationId);
      if (count === null || count === 0) return null;
      return `${String(count)} background task${count === 1 ? "" : "s"} still running: the agent is re-invoked when ${count === 1 ? "it finishes" : "each finishes"}.`;
    },
  };
}

/**
 * The CLI's own count (its last `system/background_tasks_changed`, the
 * projection's `backgroundTasks`), read after applying every line the agent
 * has written — the task the agent started earlier in this turn is on disk
 * before its Stop hook runs. A catch-up past its budget leaves the row as last
 * applied (the overdue watchdog reports the stall); that is still this
 * backend's best knowledge.
 */
async function backgroundTasksOf(
  conversationId: string,
): Promise<number | null> {
  if (!(await isSdkConversation(conversationId))) return null;
  await catchUpWithin(conversationId, CATCH_UP_BUDGET_MS);
  const row = await currentAgentRow(conversationId);
  return row?.backgroundTasks ?? null;
}

export const backgroundWorkStopWaiver = StopWaiver(
  backgroundWorkWaiver(backgroundTasksOf),
);
