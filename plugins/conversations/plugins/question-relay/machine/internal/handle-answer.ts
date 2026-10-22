import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { requestStatusReconcile } from "@plugins/conversations/server";
import { answerRelayQuestion } from "../../core/endpoints";
import { toCliAnswer } from "../../server/internal/answer";
import {
  readOpenQuestions,
  resolveQuestion,
} from "../../server/internal/store";
import { notifyQuestionResolved } from "../../server/internal/resolved";

export const handleAnswer = implementMachine(
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
