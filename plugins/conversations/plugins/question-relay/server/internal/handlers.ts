import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { requestStatusReconcile } from "@plugins/conversations/server";
import { answerRelayQuestion } from "../../core/endpoints";
import { toCliAnswer } from "./answer";
import { readOpenQuestions, resolveQuestion } from "./store";
import { notifyQuestionResolved } from "./resolved";

export const handleAnswer = implement(
  answerRelayQuestion,
  async ({ params, body }) => {
    const row = await readOpenQuestions(params.id, params.toolUseId);
    const checked = toCliAnswer(row.questions, body);
    if (!checked.ok) throw new HttpError(400, checked.error);
    await resolveQuestion(
      params.id,
      params.toolUseId,
      "answered",
      checked.answer,
    );
    requestStatusReconcile([params.id]);
    await notifyQuestionResolved({
      conversationId: params.id,
      toolUseId: params.toolUseId,
      resolution: { state: "answered", answer: checked.answer },
    });
  },
);
