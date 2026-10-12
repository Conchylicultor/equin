import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { tableRowCountServed } from "./internal/served";

export default {
  contributions: [...tableRowCountServed.declare],
} satisfies ServerPluginDefinition;
