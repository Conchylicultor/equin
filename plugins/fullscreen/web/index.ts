import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { FullscreenToggle } from "./components/fullscreen-toggle";

export { FullscreenButton } from "./components/fullscreen-toggle";

export default {
  description:
    "Browser fullscreen switch in the action bar's view-options popover, and the same switch as a toolbar button (FullscreenButton) for an app header that carries its own.",
  contributions: [
    ActionBar.ViewOption({
      id: "fullscreen-toggle",
      component: FullscreenToggle,
    }),
  ],
} satisfies PluginDefinition;
