import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type { PendingTurn } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";

/** The transcript row kinds a sent turn's line becomes. */
type EchoKind = Extract<JsonlEvent["kind"], "user-text" | "event-turn">;

/**
 * The row the transcript parser makes of each kind of turn's line — so a sent
 * turn's echo is drawn as THAT row. An `event` turn is typed in the turn
 * ledger's envelope, which the parser makes an `event-turn` (the app's voice,
 * never the user's message); every other kind's line is a user prompt. A
 * Record, so a new turn kind cannot be added without deciding what its echo
 * looks like.
 */
const ECHO_KIND: Record<PendingTurn["kind"], EchoKind> = {
  turn: "user-text",
  answer: "user-text",
  "push-and-exit": "user-text",
  launch: "user-text",
  compact: "user-text",
  event: "event-turn",
};

/**
 * The stand-in event a sent turn's echo draws: the row its transcript line
 * will be, under the turn id as its uuid.
 */
export function echoEventOf(
  turn: Pick<PendingTurn, "id" | "kind" | "text" | "sentAt">,
): Extract<JsonlEvent, { kind: EchoKind }> {
  const line = {
    at: turn.sentAt.toISOString(),
    text: turn.text,
    uuid: turn.id,
  };
  return ECHO_KIND[turn.kind] === "event-turn"
    ? { kind: "event-turn", ...line }
    : { kind: "user-text", ...line };
}
