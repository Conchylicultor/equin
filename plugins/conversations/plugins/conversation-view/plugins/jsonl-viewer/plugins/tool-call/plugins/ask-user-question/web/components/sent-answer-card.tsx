import { ToolCallFrame } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import {
  AnsweredQuestions,
  SendingStatus,
  answeredSummary,
  selectionsFromForm,
} from "./answered-view";
import type { SentAnswer } from "./sent-answers";

/**
 * A held question this tab answered, while the answer is on its way: the
 * `QuestionCard` frame with the answer drawn as the transcript will draw it,
 * "Sending…" under it — so Submit swaps the form for the answer at once, and
 * the transcript taking over only removes that line.
 */
export function SentAnswerCard({ sent }: { sent: SentAnswer }) {
  const { questions, answer } = sent;
  const selections = selectionsFromForm(questions, answer);
  return (
    <ToolCallFrame
      name="AskUserQuestion"
      summary={answeredSummary(questions, selections, answer.response)}
      defaultOpen
      running
    >
      <AnsweredQuestions
        questions={questions}
        selections={selections}
        reply={answer.response}
        footer={<SendingStatus />}
      />
    </ToolCallFrame>
  );
}
