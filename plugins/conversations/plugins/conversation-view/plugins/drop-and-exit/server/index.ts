import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { dropTaskOnExit } from "./internal/drop-task-on-exit";

export default {
  description:
    "The one exit-drop policy every conversation-close path that can drop a task shares (dropTaskOnExit): the Drop & Close endpoint (its machine half) and the agent-driven exit_clean finalize.",
} satisfies ServerPluginDefinition;
