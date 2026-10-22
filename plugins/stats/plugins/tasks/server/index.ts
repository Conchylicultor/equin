import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { tasksHistoryServed } from "./internal/history";

export default {
  contributions: [...tasksHistoryServed.declare],
} satisfies ServerPluginDefinition;
