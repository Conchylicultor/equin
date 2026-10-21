import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { AssistantThinkingRow } from "./components/assistant-thinking-row";

export default {
  description: "Renders assistant thinking blocks in the JSONL viewer as collapsible sections.",
  contributions: [
    JsonlViewer.EventRenderer({
      match: "assistant-thinking",
      component: AssistantThinkingRow,
      // A thinking block streams in as its stand-in while the model thinks.
      landsShown: true,
    }),
  ],
} satisfies PluginDefinition;
