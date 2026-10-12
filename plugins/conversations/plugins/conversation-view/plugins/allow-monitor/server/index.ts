import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { allowFilesServed } from "./internal/allow-files-resource";

export default {
  contributions: [...allowFilesServed.declare],
} satisfies ServerPluginDefinition;
