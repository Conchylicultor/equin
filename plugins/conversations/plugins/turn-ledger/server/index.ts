import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import { turnIdKind } from "../core";
import { turnMergedKind, turnUnverifiedKind } from "./internal/report-kinds";
import { conversationTurnsServed } from "./internal/resource";
import { conversationTurnsRetention } from "./internal/retention";
import { userTurnSent } from "./internal/tables-user-turn-sent-event";

export {
  acceptTurn,
  applyTurnEvent,
  getTurn,
  hasHeldTurns,
  hasPromptHook,
  holdIfStarting,
  latestSubmitAt,
  listHeldTurns,
  recordPromptHookLaunch,
  resolvePromptSubmit,
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
    "The turn ledger's backend: the conversation_turns table (one row per turn sent to an agent, its state moved only by applyTurnEvent's pure transition), the accept that holds a turn while its conversation starts, resolvePromptSubmit (the agent's confirmation that it took a turn, matched to the oldest unconfirmed one), the turn-ledger.turns live collection, the conversation.userTurnSent event (emitted once the agent confirmed a user's turn), the turn-merged / turn-unverified report kinds and a 7-day retention sweep of settled rows.",
  register: [conversationTurnsRetention, userTurnSent],
  contributions: [
    IdKinds.Kind({ kind: turnIdKind }),
    ...conversationTurnsServed.declare,
    turnMergedKind,
    turnUnverifiedKind,
  ],
} satisfies ServerPluginDefinition;
