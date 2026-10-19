import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  abandonRelayQuestion,
  answerRelayQuestion,
  awaitRelayQuestion,
  registerRelayQuestion,
  releaseRelayQuestion,
} from "../core/endpoints";
import {
  handleAbandon,
  handleAnswer,
  handleAwait,
  handleRegister,
  handleRelease,
} from "./internal/handlers";
import { relayQuestionHolds } from "./internal/holds";
import { pendingQuestionsServed } from "./internal/resource";
import { pendingQuestionsRetention } from "./internal/retention";

export { relayHookEntry } from "./internal/relay-hook";
export { holdQuestion, retireQuestion } from "./internal/held-in-process";
export { onQuestionResolved } from "./internal/resolved";
export type { ResolvedQuestion } from "./internal/resolved";

export default {
  description:
    "The AskUserQuestion relay's backend: the pending_questions table (one row per held call: open → answered | released | abandoned), the register / await (a push-woken long-poll) / answer / release / abandon endpoints, the open-questions live collection, the question-hold source that tells the status reconciler a held question is waiting (and retires holds whose relay died), and a 7-day retention sweep of resolved rows.",
  httpRoutes: {
    [registerRelayQuestion.route]: handleRegister,
    [awaitRelayQuestion.route]: handleAwait,
    [answerRelayQuestion.route]: handleAnswer,
    [releaseRelayQuestion.route]: handleRelease,
    [abandonRelayQuestion.route]: handleAbandon,
  },
  register: [relayQuestionHolds, pendingQuestionsRetention],
  contributions: [...pendingQuestionsServed.declare],
} satisfies ServerPluginDefinition;
