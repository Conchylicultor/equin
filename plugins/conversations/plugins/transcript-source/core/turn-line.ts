import type { TurnKind } from "@plugins/conversations/plugins/turn-ledger/core";
import type { JsonlEvent } from "./protocol";

/** The transcript row kinds a turn's line becomes. */
export type TurnLineKind = Extract<
  JsonlEvent["kind"],
  "user-text" | "event-turn"
>;

/**
 * The row the parser makes of each kind of turn's line. An `event` turn is
 * typed in the turn ledger's envelope, which the parser makes an `event-turn`
 * (the app's voice, never the user's message); every other kind's line is a
 * user prompt. A Record, so a new turn kind cannot be added without deciding.
 */
const LINE_KIND: Record<TurnKind, TurnLineKind> = {
  turn: "user-text",
  answer: "user-text",
  "push-and-exit": "user-text",
  launch: "user-text",
  compact: "user-text",
  event: "event-turn",
};

/**
 * The transcript row a turn of `kind` becomes — what a sent turn's echo draws
 * as, so it looks like the row that will replace it.
 */
export function turnLineKind(kind: TurnKind): TurnLineKind {
  return LINE_KIND[kind];
}
