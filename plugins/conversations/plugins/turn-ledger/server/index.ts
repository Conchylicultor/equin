import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import { turnIdKind } from "../core";
import {
  startPromptSubmitMailbox,
  promptSubmitsWatcher,
} from "./internal/mailbox";
import {
  turnInputNotEmptyKind,
  turnMergedKind,
  turnUnverifiedKind,
} from "./internal/report-kinds";
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
export { promptSubmitHookEntry } from "./internal/mailbox";
export type { PromptSubmitHookEntry } from "./internal/mailbox";
export { reportInputNotEmpty } from "./internal/report-kinds";
export { userTurnSent } from "./internal/tables-user-turn-sent-event";
export type { UserTurnSentPayload } from "./internal/tables-user-turn-sent-event";

export default {
  description:
    "The turn ledger's backend: the conversation_turns table (one row per turn sent to an agent, its state moved only by applyTurnEvent's pure transition), the accept that holds a turn while its conversation starts, the prompt-submit mailbox (each agent's UserPromptSubmit hook drops the submitted prompt in a file; a watcher matches it to the oldest unconfirmed turn and deletes it), the turn-ledger.turns live collection, the conversation.userTurnSent event (emitted once the CLI confirmed a user's turn), the turn-merged / turn-unverified / turn-input-not-empty report kinds and a 7-day retention sweep of settled rows.",
  register: [promptSubmitsWatcher, conversationTurnsRetention, userTurnSent],
  contributions: [
    IdKinds.Kind({ kind: turnIdKind }),
    ...conversationTurnsServed.declare,
    turnMergedKind,
    turnUnverifiedKind,
    turnInputNotEmptyKind,
  ],
  onReady: async () => {
    await startPromptSubmitMailbox();
  },
} satisfies ServerPluginDefinition;
