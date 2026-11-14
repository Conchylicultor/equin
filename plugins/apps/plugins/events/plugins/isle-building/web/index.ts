import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Isle } from "@plugins/apps/plugins/isle/plugins/buildings/web";
import { eventsApp } from "@plugins/apps/plugins/events/plugins/shell/core";
import { clockTower } from "../core";

export default {
  description:
    "Events' building on Isle: the clock tower, its clock showing the real time.",
  contributions: [Isle.Building({ app: eventsApp, building: clockTower })],
} satisfies PluginDefinition;
