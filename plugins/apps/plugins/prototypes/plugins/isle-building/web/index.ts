import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Isle } from "@plugins/apps/plugins/isle/plugins/buildings/web";
import { prototypesApp } from "@plugins/apps/plugins/prototypes/plugins/shell/core";
import { inventorsCabin } from "../core";

export default {
  description:
    "Prototypes' building on Isle: the inventor's sketch cabin, blueprints and a half-built contraption.",
  contributions: [
    Isle.Building({ app: prototypesApp, building: inventorsCabin }),
  ],
} satisfies PluginDefinition;
