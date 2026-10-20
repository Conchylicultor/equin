import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { answerRelayQuestion } from "../core/endpoints";
import { handleAnswer } from "./internal/handlers";
import { relayQuestionHolds } from "./internal/holds";
import { pendingQuestionsServed } from "./internal/resource";
import { pendingQuestionsRetention } from "./internal/retention";

export { holdQuestion, retireQuestion } from "./internal/held-in-process";
export { onQuestionResolved } from "./internal/resolved";
export type { ResolvedQuestion } from "./internal/resolved";

export default {
  description:
    "The AskUserQuestion relay's backend: the pending_questions table (one row per held call: open → answered | abandoned), holdQuestion / retireQuestion for the runtime holding the call in-process, the answer endpoint and onQuestionResolved, the open-questions live collection, the question-hold source that tells the status reconciler a held question is waiting (and retires holds whose holder died), and a 7-day retention sweep of resolved rows.",
  httpRoutes: {
    [answerRelayQuestion.route]: handleAnswer,
  },
  register: [relayQuestionHolds, pendingQuestionsRetention],
  contributions: [...pendingQuestionsServed.declare],
} satisfies ServerPluginDefinition;
