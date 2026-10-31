import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";

/**
 * The `waitingFor` a conversation carries while an AskUserQuestion the question
 * relay holds waits on the user.
 */
export const QUESTION_WAITING_FOR = "question";

/**
 * The `waitingFor` a conversation carries while its agent is stuck: alive and
 * at rest, holding a turn it was handed but has not started for longer than
 * an idle Claude Code ever takes (the status reconciler's `STUCK_TURN_MS`).
 * Not busy — nothing it does will move the turn — so a watch goes quiet and
 * an automatic turn holds; readers name it stuck, never idle. It clears the
 * moment the turn starts, fails or is dropped.
 */
export const STUCK_TURN_WAITING_FOR = "stuck-turn";

/**
 * Whether the user can send a turn to this conversation now — the one gate
 * every turn-sending surface (the prompt input, template chips) applies, so
 * they open and close together.
 *
 * - `starting` / `working` stay sendable: the server holds or queues the turn.
 * - A waiting question stays sendable: the server withdraws it and sends the
 *   turn in its place (`submitTurn`), so the user can ignore the question and
 *   say something else.
 */
export function canSendTurn(conversation: {
  status: ConversationStatus;
}): boolean {
  return conversation.status !== "gone" && conversation.status !== "done";
}
