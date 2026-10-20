import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { aggregateServed } from "./internal/served";

export default {
  portable: true,
  description:
    "Serves a conversation's task list folded from its Task* tool calls over the whole transcript (jsonl-viewer.task-tools.aggregate), for the progress overlay of a pane that holds only the latest events.",
  contributions: [...aggregateServed.declare],
} satisfies ServerPluginDefinition;
