import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { answerAskUserQuestion } from "../shared/endpoints";
import { handleAnswer } from "./internal/handle-answer";

export default {
  httpRoutes: {
    [answerAskUserQuestion.route]: handleAnswer,
  },
} satisfies MachinePluginDefinition;
