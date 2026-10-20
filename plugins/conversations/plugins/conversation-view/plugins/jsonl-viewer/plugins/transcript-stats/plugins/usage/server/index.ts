import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { usageBeforeServed } from "./internal/served";

export default {
  portable: true,
  description:
    "Serves the usage stat's fold of a conversation's transcript before the page's window.",
  contributions: [...usageBeforeServed.declare],
} satisfies ServerPluginDefinition;
