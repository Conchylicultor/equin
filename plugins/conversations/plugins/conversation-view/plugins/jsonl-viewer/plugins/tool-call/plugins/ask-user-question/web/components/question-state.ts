import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { isInterruptContent } from "@plugins/conversations/plugins/transcript-watcher/core";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";
import { canSendTurn, QUESTION_WAITING_FOR } from "@plugins/conversations/core";
import { ANSWER_MARKER } from "../../shared";

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;

/**
 * Where one AskUserQuestion call stands — derived from the transcript plus
 * whether anything still holds the call (the conversation row). The only way
 * the tool view decides what to draw, so every question is in exactly one arm.
 *
 * A question is answerable as the tool's real result only through its
 * **holder**: the agent process's parked `canUseTool`. That lives in the
 * process's memory alone — a process that dies with the question open takes it
 * along, and a resumed session never re-asks a call already in its transcript.
 *
 * - `held` — a live holder waits on it (`waitingFor: "question"`): the
 *   `"question"` pending prompt draws its form, the transcript card stays out.
 * - `asking` — the agent is mid-turn and the hold is not registered yet.
 * - `orphaned` — unresolved, the latest thing in the transcript, nothing holds
 *   it, and the conversation can take a turn: answered as a message
 *   (`MarkerAnswerForm`). The holder died — a crash, a restart, a hibernate
 *   kill, the move off the tmux runtime — or the tmux-era terminal cancelled it.
 * - `settled` — answered, superseded by what came after, failed, or in a
 *   conversation that can take no turn: drawn read-only.
 */
export type QuestionState =
  | { kind: "held" }
  | { kind: "asking" }
  | { kind: "orphaned" }
  | { kind: "settled" };

/** What `questionState` reads of the conversation row; null when it has none. */
export interface QuestionHolderView {
  status: ConversationStatus;
  waitingFor: string | null;
}

export function questionState(
  events: JsonlEvent[],
  toolCall: ToolCallEvent,
  conversation: QuestionHolderView | null,
): QuestionState {
  // Unresolved: no result yet, or the interrupt sentinel the tmux-era terminal
  // left when it cancelled the call to flush the answer through the input box.
  const unresolved =
    toolCall.result == null ||
    (toolCall.result.isError === true &&
      isInterruptContent(toolCall.result.content));
  if (!unresolved || !isLatest(events, toolCall)) return { kind: "settled" };
  if (conversation === null) return { kind: "settled" };
  if (conversation.waitingFor === QUESTION_WAITING_FOR) return { kind: "held" };
  if (conversation.status === "starting" || conversation.status === "working")
    return { kind: "asking" };
  return canSendTurn(conversation) ? { kind: "orphaned" } : { kind: "settled" };
}

/**
 * Nothing came after the call but the CLI's own "[Request interrupted…]" line:
 * no later tool call, no answer turn, no message the user sent instead.
 */
function isLatest(events: JsonlEvent[], toolCall: ToolCallEvent): boolean {
  const startIdx = events.findIndex(
    (e) => e.kind === "tool-call" && e.toolUseId === toolCall.toolUseId,
  );
  if (startIdx === -1) return false;
  for (let i = startIdx + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === "tool-call") return false;
    if (e.kind === "user-text" && !isInterruptContent(e.text)) return false;
  }
  return true;
}

/**
 * Locates the follow-up answer turn for a given AskUserQuestion tool-call:
 * scans forward from the tool-call, bounded by the next tool-call (the window
 * for this question), and returns the first `user-text` event whose trimmed
 * text starts with `ANSWER_MARKER`. A windowed, marker-keyed lookup — not a
 * blind positional scan. Returns the event (its `uuid` is what a rewind cuts
 * at), or null.
 */
export function findAnswerTurn(
  events: JsonlEvent[] | undefined,
  toolUseId: string,
): Extract<JsonlEvent, { kind: "user-text" }> | null {
  if (!events) return null;
  const startIdx = events.findIndex(
    (e) => e.kind === "tool-call" && e.toolUseId === toolUseId,
  );
  if (startIdx === -1) return null;
  for (let i = startIdx + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === "tool-call") break; // window boundary: next tool-call
    if (e.kind === "user-text" && e.text.trim().startsWith(ANSWER_MARKER)) {
      return e;
    }
  }
  return null;
}
