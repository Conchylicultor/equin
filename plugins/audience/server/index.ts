import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { audienceConfig } from "../shared/config";

export { getAudience } from "./get-audience";

export default {
  description:
    "Registers the Developer mode config and reads the user's audience on the server (getAudience).",
  contributions: [ConfigV2.Register({ descriptor: audienceConfig })],
  portable: true,
} satisfies ServerPluginDefinition;
