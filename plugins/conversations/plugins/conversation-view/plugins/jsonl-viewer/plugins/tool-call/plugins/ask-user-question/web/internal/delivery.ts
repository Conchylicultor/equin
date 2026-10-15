import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import type { TurnDelivery } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import { answerAskUserQuestion } from "../../shared";

/**
 * Answering an AskUserQuestion is a turn send wearing a different hat: the
 * serialized answer is typed into the CLI like any turn and gets a ledger row
 * (kind `answer`). It travels over `answer-question` rather than `turn` only
 * because the runtime must first dismiss the CLI's interactive menu — a
 * delivery difference, not a lifecycle one.
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
