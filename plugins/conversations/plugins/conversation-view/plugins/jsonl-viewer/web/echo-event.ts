import {
  turnLineKind,
  type JsonlEvent,
  type TurnLineKind,
} from "@plugins/conversations/plugins/transcript-source/core";
import type { PendingTurn } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";

/**
 * The stand-in event a sent turn's echo draws: the row its transcript line
 * will be (`turnLineKind` — an `event` turn's is the event card, never the
 * user's message), under the turn id as its uuid.
 */
export function echoEventOf(
  turn: Pick<PendingTurn, "id" | "kind" | "text" | "sentAt">,
): Extract<JsonlEvent, { kind: TurnLineKind }> {
  const line = {
    at: turn.sentAt.toISOString(),
    text: turn.text,
    uuid: turn.id,
  };
  return turnLineKind(turn.kind) === "event-turn"
    ? { kind: "event-turn", ...line }
    : { kind: "user-text", ...line };
}
