import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Isle } from "@plugins/apps/plugins/isle/plugins/buildings/web";
import { keyboardPartyApp } from "@plugins/apps/plugins/keyboard-party/plugins/shell/core";
import { schoolhouse } from "../core";

export default {
  description:
    "Keyboard Party's building on Isle: the schoolhouse, chalk writing Aa, Bb\u2026 on its slate.",
  contributions: [
    Isle.Building({ app: keyboardPartyApp, building: schoolhouse }),
  ],
} satisfies PluginDefinition;
