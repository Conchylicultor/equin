import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { PromptEditorSlots } from "@plugins/primitives/plugins/prompt-editor/web";
import { ConfigV2 } from "@plugins/config_v2/web";
import { PushAndExitButton } from "./components/push-and-exit-button";
import { pushAndExitConfig } from "../shared/config";

// Re-exported so the module EVALUATES at plugin load, not at first button
// mount: a persisted `failed-post` record's Retry has to find this delivery in
// the registry after a reload. See pending-turn/web/internal/delivery.ts.
export { pushAndExitDelivery } from "./internal/delivery";

export default {
  description:
    "Toolbar button that asks Claude to push the branch and close the conversation; surfaces Claude's flag if it has anything to raise.",
  contributions: [
    PromptEditorSlots.FloatingAction({
      id: "push-and-exit",
      requires: ["git"],
      component: PushAndExitButton,
      alwaysActive: true,
    }),
    ConfigV2.WebRegister({ descriptor: pushAndExitConfig }),
  ],
} satisfies PluginDefinition;
