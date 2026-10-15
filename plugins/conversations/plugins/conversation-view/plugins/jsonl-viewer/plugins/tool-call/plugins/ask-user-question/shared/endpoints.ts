import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { z } from "zod";
import { turnIdKind } from "@plugins/conversations/plugins/turn-ledger/core";

export const AnswerAskUserQuestionBodySchema = z.object({
  text: z.string().min(1),
  /** The answer's ledger id, minted by the client; minted by the server when absent. */
  turnId: turnIdKind.schema.optional(),
});

export const answerAskUserQuestion = defineEndpoint({
  route: "POST /api/conversations/:id/answer-question",
  body: AnswerAskUserQuestionBodySchema,
  response: z.object({ turnId: z.string() }),
});

export const flushQuestion = defineEndpoint({
  route: "POST /api/conversations/:id/flush-question",
  response: z.object({ ok: z.boolean() }),
});
