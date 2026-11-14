import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Isle } from "@plugins/apps/plugins/isle/plugins/buildings/web";
import { chordApp } from "@plugins/apps/plugins/chord/plugins/shell/core";
import { bandstand } from "../core";

export default {
  description:
    "Chord's building on Isle: the bandstand, a guitar on its stand under an octagonal roof.",
  contributions: [Isle.Building({ app: chordApp, building: bandstand })],
} satisfies PluginDefinition;
