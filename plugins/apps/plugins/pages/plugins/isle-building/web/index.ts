import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Isle } from "@plugins/apps/plugins/isle/plugins/buildings/web";
import { pagesApp } from "@plugins/apps/plugins/pages/plugins/shell/core";
import { library } from "../core";

export default {
  description:
    "Pages' building on Isle: the library, a pedimented stone hall with a carved open book.",
  contributions: [Isle.Building({ app: pagesApp, building: library })],
} satisfies PluginDefinition;
