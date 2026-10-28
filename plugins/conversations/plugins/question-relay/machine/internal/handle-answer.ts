import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import {
  requestStatusReconcile,
  resolvePromptAttachments,
} from "@plugins/conversations/server";
import { answerRelayQuestion } from "../../core/endpoints";
import type { AnswerQuestionBody } from "../../core/schemas";
import { toCliAnswer } from "../../server/internal/answer";
import {
  readOpenQuestions,
  resolveQuestion,
} from "../../server/internal/store";
import { notifyQuestionResolved } from "../../server/internal/resolved";

/**
 * The user's own rich text in an answer — each "Other" and the reply — with
 * what it attached as disk paths the agent can open, like a turn's.
 */
async function withAttachmentsResolved(
  conversationId: string,
  body: AnswerQuestionBody,
): Promise<AnswerQuestionBody> {
  const resolve = (text: string) =>
    resolvePromptAttachments(conversationId, text);
  const selections: AnswerQuestionBody["selections"] = {};
  for (const [question, selection] of Object.entries(body.selections)) {
    selections[question] = {
      ...selection,
      other: selection.other === null ? null : await resolve(selection.other),
    };
  }
  return {
    ...body,
    selections,
    ...(body.response === undefined
      ? {}
      : { response: await resolve(body.response) }),
  };
}

export const handleAnswer = implementMachine(
  answerRelayQuestion,
  async ({ params, body }) => {
    const row = await readOpenQuestions(params.id, params.toolUseId);
    const checked = toCliAnswer(
      row.questions,
      await withAttachmentsResolved(params.id, body),
    );
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
