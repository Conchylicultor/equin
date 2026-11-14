import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Isle } from "@plugins/apps/plugins/isle/plugins/buildings/web";
import { placesApp } from "@plugins/apps/plugins/places/plugins/shell/core";
import { lighthouse } from "../core";

export default {
  description:
    "Places' building on Isle: the cartographer's lighthouse on its rocks, beams sweeping the sea at dusk and night.",
  contributions: [Isle.Building({ app: placesApp, building: lighthouse })],
} satisfies PluginDefinition;
