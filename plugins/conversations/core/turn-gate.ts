import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";

/**
 * The `waitingFor` a conversation carries while an AskUserQuestion waits on the
 * user — held by the question relay (no menu on screen) or drawn as the CLI's
 * own menu.
 */
export const QUESTION_WAITING_FOR = "question";

/**
 * Whether the user can send a turn to this conversation now — the one gate
 * every turn-sending surface (the prompt input, template chips) applies, so
 * they open and close together.
 *
 * - `starting` / `working` stay sendable: the server holds or queues the turn.
 * - A waiting question stays sendable: the server dismisses it (as Escape in
 *   the terminal would) and sends the turn in its place (`submitTurn`), so the
 *   user can ignore the question and say something else.
 * - Any other wait (a terminal menu, a permission prompt) is not: a turn typed
 *   into that menu would pick an option the user never chose.
 */
export function canSendTurn(conversation: {
  status: ConversationStatus;
  waitingFor: string | null;
}): boolean {
  if (conversation.status === "gone" || conversation.status === "done")
    return false;
  return (
    conversation.waitingFor === null ||
    conversation.waitingFor === QUESTION_WAITING_FOR
  );
}
