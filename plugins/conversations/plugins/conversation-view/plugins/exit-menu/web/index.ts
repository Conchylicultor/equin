import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { PromptEditorSlots } from "@plugins/primitives/plugins/prompt-editor/web";
import { ExitMenu as ExitMenuSlots } from "./slots";
import { ExitMenuButton } from "./components/exit-menu-button";

export { ExitMenu } from "./slots";

export default {
  description:
    "Ghost icon button next to Push & Exit that opens a menu of exit actions (hold, exit, drop, drop dependents). Hosts the ExitMenu.Item slot each action contributes to.",
  contributions: [
    PromptEditorSlots.FloatingAction({
      id: "exit-menu",
      requires: [],
      component: ExitMenuButton,
      alwaysActive: true,
    }),
  ],
  slots: ExitMenuSlots,
} satisfies PluginDefinition;
