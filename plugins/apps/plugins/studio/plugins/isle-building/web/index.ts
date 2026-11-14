import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Isle } from "@plugins/apps/plugins/isle/plugins/buildings/web";
import { studioApp } from "@plugins/apps/plugins/studio/plugins/shell/core";
import { conservatory } from "../core";

export default {
  description:
    "Studio's building on Isle: the conservatory laboratory, a glasshouse of plants and jars.",
  contributions: [Isle.Building({ app: studioApp, building: conservatory })],
} satisfies PluginDefinition;
