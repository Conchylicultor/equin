import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Isle } from "@plugins/apps/plugins/isle/plugins/buildings/web";
import { settingsApp } from "@plugins/apps/plugins/settings/plugins/shell/core";
import { windmill } from "../core";

export default {
  description:
    "Settings' building on Isle: the tower windmill, its sails and gears turning.",
  contributions: [Isle.Building({ app: settingsApp, building: windmill })],
} satisfies PluginDefinition;
