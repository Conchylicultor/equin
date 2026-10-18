import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { mainCheckoutServed } from "./internal/served";
import { placesConfig } from "../shared/config";

export default {
  description:
    "Where the file explorer's Singularity place leads: serves the file-explorer.main-checkout value, the main checkout's path; registers the pinned-favorites config.",
  contributions: [
    ...mainCheckoutServed.declare,
    ConfigV2.Register({ descriptor: placesConfig }),
  ],
} satisfies ServerPluginDefinition;
