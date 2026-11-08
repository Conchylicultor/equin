import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { placesConfig } from "../shared/config";

export default {
  description:
    "The file explorer's places, portable half: registers the pinned-favorites config.",
  contributions: [ConfigV2.Register({ descriptor: placesConfig })],
} satisfies ServerPluginDefinition;
