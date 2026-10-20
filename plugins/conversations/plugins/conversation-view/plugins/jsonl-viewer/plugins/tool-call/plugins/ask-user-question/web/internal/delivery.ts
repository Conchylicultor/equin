import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import type { TurnDelivery } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import { answerAskUserQuestion } from "../../shared";

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
  async send(conversationId, text, turnId, signal) {
    await fetchEndpoint(
      answerAskUserQuestion,
      { id: conversationId },
      { body: { text, turnId }, signal },
    );
  },
};
