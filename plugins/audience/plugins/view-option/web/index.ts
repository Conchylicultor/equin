import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { DeveloperModeSwitch } from "./components/developer-mode-switch";

export default {
  description:
    "The Developer mode switch in the action bar's view-options popover — the same setting as Settings → Config → Developer mode.",
  contributions: [
    ActionBar.ViewOption({
      id: "developer-mode",
      component: DeveloperModeSwitch,
    }),
  ],
} satisfies PluginDefinition;
