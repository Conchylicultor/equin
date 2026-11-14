import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Isle } from "@plugins/apps/plugins/isle/plugins/buildings/web";
import { deployApp } from "@plugins/apps/plugins/deploy/plugins/shell/core";
import { launchTower } from "../core";

export default {
  description:
    "Deploy's building on Isle: the timber launch tower and its rocket.",
  contributions: [Isle.Building({ app: deployApp, building: launchTower })],
} satisfies PluginDefinition;
