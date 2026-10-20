import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { pushLanded } from "@plugins/tasks/plugins/tasks-core/server";
import { markProgressPushedJob } from "./internal/push-job";
import { conversationProgressRowsServed } from "./internal/resource";

export { conversationProgress } from "./internal/tables";
export { markProgressPushedJob } from "./internal/push-job";

export default {
  portable: true,
  description:
    "Tracks each conversation through four phases (research → design → implementation → pushed): serves the per-conversation progress row and marks every conversation of an attempt pushed when its work lands. The git heuristic that classifies the first three phases runs in the machine half.",
  contributions: [
    ...conversationProgressRowsServed.declare,
    Trigger({
      on: pushLanded,
      do: markProgressPushedJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [markProgressPushedJob],
} satisfies ServerPluginDefinition;
