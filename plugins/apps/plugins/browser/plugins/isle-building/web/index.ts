import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Isle } from "@plugins/apps/plugins/isle/plugins/buildings/web";
import { browserApp } from "@plugins/apps/plugins/browser/plugins/shell/core";
import { observatory } from "../core";

export default {
  description:
    "The Browser's building on Isle: the observatory, its dome slot and telescope slowly turning.",
  contributions: [Isle.Building({ app: browserApp, building: observatory })],
} satisfies PluginDefinition;
