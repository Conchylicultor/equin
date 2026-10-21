import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { JsonlRowActions } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import { AssistantTextRow } from "./components/assistant-text-row";
import { CopyAssistantTextAction } from "./components/copy-text-action";
import { MarkdownToggleAction } from "./components/markdown-toggle-action";

export default {
  description:
    "Renders assistant text events in the JSONL viewer, with optional markdown rendering; a text block the agent is still writing (a jsonl-viewer streaming stand-in) is revealed at a steady pace with a soft fading edge rather than in the bursts it arrives in.",
  contributions: [
    JsonlViewer.EventRenderer({
      match: "assistant-text",
      component: AssistantTextRow,
      // Its stand-in already drew the reply as it was written.
      landsShown: true,
    }),
    JsonlRowActions.Item({
      id: "markdown-toggle",
      component: MarkdownToggleAction,
    }),
    JsonlRowActions.Item({
      id: "copy-assistant-text",
      component: CopyAssistantTextAction,
    }),
  ],
} satisfies PluginDefinition;
