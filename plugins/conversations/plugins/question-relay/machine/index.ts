import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { answerRelayQuestion } from "../core/endpoints";
import { handleAnswer } from "./internal/handle-answer";
import { relayQuestionHolds } from "./internal/holds";

export { holdQuestion, retireQuestion } from "./internal/held-in-process";

export default {
  description:
    "The AskUserQuestion relay's desktop-only half: holdQuestion / retireQuestion for the runtime holding the call in-process (its liveness a host pid), the question-hold source that tells the status reconciler a held question is waiting (and retires holds whose holder died), the answer endpoint (needsMachine) — it resolves the held question and hands the answer to the agent's runtime.",
  register: [relayQuestionHolds],
  httpRoutes: {
    [answerRelayQuestion.route]: handleAnswer,
  },
} satisfies MachinePluginDefinition;
