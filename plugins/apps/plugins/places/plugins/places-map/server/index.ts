import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { placeCardsConfig } from "../core";

export default {
  description:
    "Registers the Places place-cards setting (the opening hours on the side panel's cards).",
  contributions: [ConfigV2.Register({ descriptor: placeCardsConfig })],
} satisfies ServerPluginDefinition;
