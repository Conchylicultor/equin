import { useState } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  AnswerForm,
  QuestionCard,
  answerDraftScope,
  type FormAnswer,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/ask-user-question/web";
import {
  answerRelayQuestion,
  pendingQuestions,
  type PendingQuestion,
} from "../../core";

/**
 * The `"question"` pending prompt: the question the agent holds, answered right
 * here as the tool's real answer.
 */
export function RelayQuestionCard({
  conversationId,
}: {
  conversationId: string;
}) {
  const held = useLive(pendingQuestions, { where: { conversationId } });
  // The question this card answered: its row leaves the collection at once,
  // while the conversation stays "waiting on a question" until the reconciler
  // sees the agent move on (which unmounts this card). Say the answer is on its
  // way meanwhile.
  const [answered, setAnswered] = useState<string | null>(null);

  if (held.status === "loading") return <Loading label="Loading question…" />;
  if (held.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the held question"
        error={held.error}
        refetch={held.refetch}
      />
    );
  }
  // Oldest first: the CLI asks one question call at a time.
  const question = held.data[0];
  if (question) {
    return (
      <HeldQuestion
        key={question.toolUseId}
        question={question}
        onAnswered={() => setAnswered(question.toolUseId)}
      />
    );
  }
  // No open row while the conversation still waits on a question: answered
  // here, or from another tab, and the reconciler has not seen the agent move
  // on yet.
  return (
    <Text as="p" variant="caption" tone="muted">
      {answered !== null
        ? "Answer sent — the agent is reading it."
        : "The question was answered — the agent is reading it."}
    </Text>
  );
}

function HeldQuestion({
  question,
  onAnswered,
}: {
  question: PendingQuestion;
  onAnswered: () => void;
}) {
  const params = {
    id: question.conversationId,
    toolUseId: question.toolUseId,
  };
  const answer = useEndpointMutation(answerRelayQuestion);

  // Not a turn: the answer is the tool's own input, so there is no pending-turn
  // record — the tool result landing in the transcript is the confirmation. A
  // failed POST is reported by the mutation's global toast, and the form keeps
  // the user's picks (it clears its draft only on `true`). The answer reaches
  // the agent's runtime, which needs the computer: on a host without it (the
  // demo) the form's Submit is disabled and says why.
  const submit = ({ selections, response }: FormAnswer): Promise<boolean> => {
    // Unreachable: Submit is disabled while unavailable.
    if (answer.kind === "unavailable") throw new Error(answer.message);
    return answer
      .mutateAsync({
        params,
        body: { selections, ...(response ? { response } : {}) },
      })
      .then(
        () => {
          onAnswered();
          return true;
        },
        () => false,
      );
  };

  // The same card the transcript draws an AskUserQuestion with, so the held
  // question reads as the tool call it is.
  return (
    <QuestionCard questions={question.questions}>
      <AnswerForm
        questions={question.questions}
        draftScope={answerDraftScope(
          question.conversationId,
          question.toolUseId,
        )}
        onSubmit={submit}
        availability={
          answer.kind === "unavailable"
            ? { available: false, message: answer.message }
            : { available: true }
        }
      />
    </QuestionCard>
  );
}
