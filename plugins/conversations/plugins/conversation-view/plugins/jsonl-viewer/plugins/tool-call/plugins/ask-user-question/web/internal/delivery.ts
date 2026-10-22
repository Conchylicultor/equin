import type { TurnDelivery } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import { useMachineAvailability } from "@plugins/infra/plugins/endpoints/web";
import type { MachineAvailability } from "@plugins/infra/plugins/endpoints/core";
import { answerAskUserQuestion } from "../../shared";

/**
 * Whether an answer can be sent here: it reaches the agent, which needs the
 * computer (`needsMachine`) — so on a host without it (the demo) the form's
 * Submit is disabled before a send can start. Read here, beside the delivery,
 * so the form never names the turn endpoint itself.
 */
export function useAnswerQuestionAvailability(): MachineAvailability {
  return useMachineAvailability(answerAskUserQuestion);
}

/**
 * Answering an AskUserQuestion as text is a turn send wearing a different
 * hat: the serialized answer is sent like any turn and gets a ledger row (kind
 * `answer`). It travels over `answer-question` rather than `turn` only because
 * the runtime must first withdraw any open question — a delivery difference,
 * not a lifecycle one.
 *
 * An `answer` draws no in-flight echo — the question card already shows its own
 * answered state, and the delivered turn is hidden from the transcript — but
 * its failure card (Retry, Copy to draft) renders like any other.
 */
export const answerQuestionDelivery: TurnDelivery = {
  kind: "answer",
  async send(fetchEndpoint, conversationId, text, turnId, signal) {
    const result = await fetchEndpoint(
      answerAskUserQuestion,
      { id: conversationId },
      { body: { text, turnId }, signal },
    );
    // The form is disabled where this is unavailable, so reaching it is a bug:
    // reject (the send's failure card), never resolve as if it was recorded.
    if (result.kind === "unavailable") throw new Error(result.message);
  },
};
