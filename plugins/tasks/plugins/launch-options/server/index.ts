import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { TaskLaunchServer } from "./internal/contribution";
export type {
  TaskLaunchContext,
  TaskLaunchServerEntry,
} from "./internal/contribution";
export { inheritLaunchOptions } from "./internal/inherit";
export { resolveLaunchOptions } from "./internal/resolve";
export type { ResolvedLaunchOption } from "./internal/resolve";

export default {
  description:
    "Server half of the task launch-option registry: each option contributes how its value is written onto a task — applied from a draft, and whether it is inherited by a spawned subtask — so the chain endpoint and the task-filing MCP tools stay generic.",
  contributions: [],
} satisfies ServerPluginDefinition;
