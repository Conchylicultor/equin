import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { InstructionsView } from "./components/instructions-view";

export default {
  collapsed: true,
  description:
    "Renders the instructions attachment in both its flavors — the launch snapshot of the project instruction files (CLAUDE.md), and the session-start re-read reporting which of them dropped out — as the plural twin of the nested-memory card.",
  contributions: [
    ...attachmentRenderer({
      match: "instructions",
      component: InstructionsView,
      role: "context",
    }),
  ],
} satisfies PluginDefinition;
