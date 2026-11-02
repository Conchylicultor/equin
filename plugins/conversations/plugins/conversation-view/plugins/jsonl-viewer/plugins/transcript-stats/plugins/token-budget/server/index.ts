import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { budgetBeforeServed } from "./internal/served";

export default {
  description:
    "Serves the token-budget stat's fold of a conversation's transcript before the page's window.",
  contributions: [...budgetBeforeServed.declare],
} satisfies ServerPluginDefinition;
