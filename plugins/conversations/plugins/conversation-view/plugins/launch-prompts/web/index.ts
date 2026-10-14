import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/web";
import { ConfigV2 } from "@plugins/config_v2/web";
import { DynamicEnum } from "@plugins/fields/plugins/dynamic-enum/plugins/config/web";
import { useModelChoiceOptions } from "@plugins/conversations/plugins/model-provider/web";
import { launchPromptsConfig } from "../shared/config";
import { LaunchPromptsButton } from "./components/launch-prompts-button";

export default {
  description:
    "Pre-configured prompts that launch a new background conversation in the same worktree.",
  contributions: [
    Conversation.PromptBar({
      id: "launch-prompts",
      requires: [],
      component: LaunchPromptsButton,
      section: "Launch",
      sectionOrder: 2,
    }),
    ConfigV2.WebRegister({ descriptor: launchPromptsConfig }),
    // A prompt's model is picked from the live model catalog.
    DynamicEnum.Options({
      field: launchPromptsConfig.fields.prompts.itemFields.model,
      useOptions: useModelChoiceOptions,
    }),
  ],
} satisfies PluginDefinition;
