import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { tableColumnsServed } from "./internal/served";

export default {
  contributions: [...tableColumnsServed.declare],
} satisfies ServerPluginDefinition;
