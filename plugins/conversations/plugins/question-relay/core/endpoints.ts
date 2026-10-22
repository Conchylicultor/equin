import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { AnswerQuestionBodySchema } from "./schemas";

/** Answer a held question from the web. 409 once it is no longer open. */
export const answerRelayQuestion = defineEndpoint({
  route: "POST /api/conversations/:id/questions/:toolUseId/answer",
  body: AnswerQuestionBodySchema,
  needsMachine: { feature: "Answering an agent's question" },
});
