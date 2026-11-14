import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Isle } from "@plugins/apps/plugins/isle/plugins/buildings/web";
import { sonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/core";
import { musicHall } from "../core";

export default {
  description:
    "Sonata's building on Isle: the music hall, a grand piano in its great arched window.",
  contributions: [Isle.Building({ app: sonataApp, building: musicHall })],
} satisfies PluginDefinition;
