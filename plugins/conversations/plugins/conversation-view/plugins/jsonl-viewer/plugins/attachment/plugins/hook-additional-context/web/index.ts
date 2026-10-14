import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { HookAdditionalContextView } from "./components/hook-additional-context-view";

export default {
  collapsed: true,
  description:
    "Renders hook_additional_context attachment events: the context a PreToolUse/PostToolUse hook injected into the agent before a tool ran.",
  contributions: [
    ...attachmentRenderer({
      match: "hook_additional_context",
      component: HookAdditionalContextView,
      role: "conversation",
    }),
  ],
} satisfies PluginDefinition;
