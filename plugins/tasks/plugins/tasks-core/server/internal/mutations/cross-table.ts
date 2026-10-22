import type { Conversation } from "../schema";
import { listActiveConversations } from "../queries/conversations";
import { dropTaskTree, updateTask } from "./tasks";

// ONE HALF of the exit-drop policy, and named for exactly the half it is: does
// any sibling conversation on this task remain active? If one does, another
// conversation may still land the work, so this closing one must not drop the
// task. The closing conversation is excluded by id, so callers may invoke this
// either before or after marking it closed.
//
// The other half — "does this attempt have work at stake?" — deliberately does
// NOT live here. It used to: this function read `listPushesForAttempt` and
// treated an empty result as proof that nothing was pushed, which was false
// whenever the ledger's background ingest lagged (observed 40+ minutes behind a
// wedged queue) and is still false for an attempt whose commits are not pushed
// yet. An agent that pushed and then exited cleanly got its task dropped. That fact is now git-measured by `tasks/attempt-work`, and the whole
// policy lives in the plugin named for it, `conversation-view/drop-and-exit`,
// as `dropTaskOnExit` — the only thing callers should reach for. tasks-core has
// no business guessing at an attempt's standing, and an honest name here cannot
// be mistaken for the whole policy.
// Design: research/2026-08-17-global-attempt-work-git-derived-standing.md.
//
// Returns whether the task was dropped.
export async function dropTaskIfNoActiveSibling(
  conversation: Conversation,
): Promise<boolean> {
  if (await hasActiveSibling(conversation)) return false;
  await updateTask(conversation.taskId, { drop: true });
  return true;
}

export type DropTaskTreeResult =
  | { kind: "dropped"; count: number }
  | { kind: "kept"; reason: "active-sibling" };

// The same sibling rule for the closing conversation's "drop the task and
// every active dependent" sweep. It is the ONLY drop-tree entry point the
// barrel publishes, so a conversation-driven sweep cannot skip the check: one
// skipped it, and closing an old conversation dropped a task whose new
// conversation was still working — and, with it, 19 dependents.
export async function dropTaskTreeIfNoActiveSibling(
  conversation: Conversation,
): Promise<DropTaskTreeResult> {
  if (await hasActiveSibling(conversation)) {
    return { kind: "kept", reason: "active-sibling" };
  }
  return { kind: "dropped", count: await dropTaskTree(conversation.taskId) };
}

async function hasActiveSibling(conversation: Conversation): Promise<boolean> {
  const activeConversations = await listActiveConversations();
  return activeConversations.some(
    (c) => c.taskId === conversation.taskId && c.id !== conversation.id,
  );
}
