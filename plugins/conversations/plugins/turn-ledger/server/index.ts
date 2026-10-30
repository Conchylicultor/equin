import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import { turnIdKind } from "../core";
import { conversationTurnsServed } from "./internal/resource";
import { userTurnSent } from "./internal/tables-user-turn-sent-event";
import { conversationTurnsRetention } from "./internal/retention";

export {
  acceptTurn,
  applyTurnEvent,
  confirmTurn,
  dropTypedTurns,
  getTurn,
  hasHeldTurns,
  holdIfStarting,
  latestSubmitAt,
  listHeldTurns,
  resolvePromptSubmit,
  returnHeldTurns,
  hasTurnInFlight,
  returnTurnByPromptUuid,
  returnTurnsSince,
} from "./internal/store";
export { onTurnSubmitted } from "./internal/submit-signal";
export type { AcceptOutcome, NewTurn, TurnRow } from "./internal/store";
export type { TurnEvent } from "./internal/transition";
export { userTurnSent } from "./internal/tables-user-turn-sent-event";
export type { UserTurnSentPayload } from "./internal/tables-user-turn-sent-event";

export default {
  description:
    "The turn ledger's backend: the conversation_turns table (one row per turn sent to an agent, its state moved only by applyTurnEvent's pure transition), the accept that holds a turn while its conversation starts, confirmTurn (the agent's confirmation that it took a turn, applied to that row by the turn id it echoed, with the transcript line's uuid; resolvePromptSubmit is its temporary equality-matched fallback for an agent started before turn ids), Stop's and rewind's returnTurnByPromptUuid (the turn taken back, by its transcript line), the turn-ledger.turns live collection, the conversation.userTurnSent event (emitted once the agent confirmed a user's turn) and the 7-day retention sweep of settled rows.",
  portable: true,
  register: [userTurnSent, conversationTurnsRetention],
  contributions: [
    IdKinds.Kind({ kind: turnIdKind }),
    ...conversationTurnsServed.declare,
  ],
} satisfies ServerPluginDefinition;
