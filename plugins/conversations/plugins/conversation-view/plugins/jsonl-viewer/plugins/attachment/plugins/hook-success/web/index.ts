import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { HookSuccessView } from "./components/hook-success-view";

export default {
  collapsed: true,
  description:
    "Renders hook_success attachment events: the execution record of a hook command (which hook, exit code, duration), surfacing stderr/non-zero exits.",
  contributions: [
    ...attachmentRenderer({
      match: "hook_success",
      component: HookSuccessView,
      role: "conversation",
    }),
  ],
} satisfies PluginDefinition;
