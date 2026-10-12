import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { mainCheckoutServed } from "./internal/served";

export default {
  description:
    "Where the file explorer's Singularity place leads: serves the file-explorer.main-checkout value, the main checkout's path.",
  contributions: [...mainCheckoutServed.declare],
} satisfies ServerPluginDefinition;
