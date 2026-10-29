import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { AnswerQuestionBodySchema } from "./schemas";

/** Answer a held question from the web. 409 once it is no longer open. */
export const answerRelayQuestion = defineEndpoint({
  route: "POST /api/conversations/:id/questions/:toolUseId/answer",
  body: AnswerQuestionBodySchema,
  needsMachine: { feature: "Answering an agent's question" },
  unpredicted: {
    reason: "precondition",
    why: "The server answers 409 once the question is no longer open, and the card restores the user's picks on failure instead of reverting.",
  },
});
