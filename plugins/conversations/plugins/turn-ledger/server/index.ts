import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import { turnIdKind } from "../core";
import { conversationTurnsServed } from "./internal/resource";
import { userTurnSent } from "./internal/tables-user-turn-sent-event";

export {
  acceptTurn,
  applyTurnEvent,
  getTurn,
  hasHeldTurns,
  holdIfStarting,
  latestSubmitAt,
  listHeldTurns,
  resolvePromptSubmit,
  returnHeldTurns,
  hasTurnInFlight,
  returnTurnByText,
  returnTurnsSince,
} from "./internal/store";
export { onTurnSubmitted } from "./internal/submit-signal";
export type { AcceptOutcome, NewTurn, TurnRow } from "./internal/store";
export type { TurnEvent } from "./internal/transition";
export { userTurnSent } from "./internal/tables-user-turn-sent-event";
export type { UserTurnSentPayload } from "./internal/tables-user-turn-sent-event";

export default {
  description:
    "The turn ledger's backend: the conversation_turns table (one row per turn sent to an agent, its state moved only by applyTurnEvent's pure transition), the accept that holds a turn while its conversation starts, resolvePromptSubmit (the agent's confirmation that it took a turn, matched to the oldest unconfirmed one), the turn-ledger.turns live collection, the conversation.userTurnSent event (emitted once the agent confirmed a user's turn) and turnVerdictSink (a merged or unverified turn, filed as a report by machine/).",
  portable: true,
  register: [userTurnSent],
  contributions: [
    IdKinds.Kind({ kind: turnIdKind }),
    ...conversationTurnsServed.declare,
  ],
} satisfies ServerPluginDefinition;
