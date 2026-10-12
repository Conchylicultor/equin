import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { tableForeignKeysServed } from "./internal/served";

export default {
  contributions: [...tableForeignKeysServed.declare],
} satisfies ServerPluginDefinition;
