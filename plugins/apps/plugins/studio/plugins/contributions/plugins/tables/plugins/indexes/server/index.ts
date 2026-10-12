import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { tableIndexesServed } from "./internal/served";

export default {
  contributions: [...tableIndexesServed.declare],
} satisfies ServerPluginDefinition;
