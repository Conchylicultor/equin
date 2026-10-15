import { sendConversationTurn } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import { answerQuestionDelivery } from "../internal/delivery";
import { AnswerForm } from "./answer-form";
import { answerDraftScope } from "./answer-draft";
import {
  serializeMarkerAnswer,
  type FormAnswer,
  type Question,
} from "./answer-model";

/**
 * The answer form for a question the terminal already cancelled (the flush
 * path: hookless sessions, or a question released to the terminal and then
 * pulled back with "Answer here"). The answer reaches the agent as a pasted
 * turn, after the cancelled call.
 */
export function MarkerAnswerForm({
  questions,
  convId,
  toolUseId,
}: {
  questions: Question[];
  convId: string;
  toolUseId: string;
}) {
  // An answer is a turn: it reaches the agent through the same input box, so it
  // goes through the one send entry point and gets a ledger row and, should it
  // fail, the Retry card. An `answer` draws no in-flight echo — the question
  // card is this send's in-flight display, and the delivered turn is hidden
  // from the transcript by our own EventFilter. The send returns synchronously
  // and the ledger owns its fate, so the answer counts as accepted at once.
  const submit = (answer: FormAnswer) => {
    const text = serializeMarkerAnswer(questions, answer);
    sendConversationTurn(convId, { text, delivery: answerQuestionDelivery });
    return true;
  };
  return (
    <AnswerForm
      questions={questions}
      draftScope={answerDraftScope(convId, toolUseId)}
      onSubmit={submit}
    />
  );
}
