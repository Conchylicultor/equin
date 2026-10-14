import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { HarnessNudgeView } from "./components/harness-nudge-view";

export default {
  collapsed: true,
  description:
    "Renders the one-line coaching notes the harness slips the agent mid-session — the batching reminder and the check-in reminder.",
  contributions: [
    ...attachmentRenderer({
      match: "batching_reminder_sent",
      component: HarnessNudgeView,
      role: "conversation",
    }),
    ...attachmentRenderer({
      match: "silent_turn_reminder",
      component: HarnessNudgeView,
      role: "conversation",
    }),
  ],
} satisfies PluginDefinition;
