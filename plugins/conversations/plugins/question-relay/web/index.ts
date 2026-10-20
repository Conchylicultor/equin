import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { RelayQuestionCard } from "./components/relay-question-card";

export default {
  description:
    "Answers a held AskUserQuestion from the web: owns the transcript's `\"question\"` pending prompt — the held question's form, answered as the tool's real result.",
  contributions: [
    JsonlViewer.PendingPrompt({
      match: "question",
      component: RelayQuestionCard,
    }),
  ],
} satisfies PluginDefinition;
