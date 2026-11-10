import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { cannotJudgeKind } from "./internal/cannot-judge-kind";

export default {
  description:
    "The restart-skip-cannot-judge report kind — filed by `./equin build` through the report outbox when the backend or central it asked to adopt a deploy could not measure its own code (the closure walk refused it): the deploy restarts all the same, but restart-skip is off until the cause is fixed, so it is reported rather than left as one more 'restart needed' log line.",
  contributions: [cannotJudgeKind],
} satisfies ServerPluginDefinition;
