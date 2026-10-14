import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/web";
import { BranchButtons } from "./components/branch-buttons";

export default {
  description:
    "Forks the current Claude session into a background conversation with the typed draft as the opening prompt.",
  contributions: [
    Conversation.PromptBar({
      id: "branch",
      requires: [],
      component: BranchButtons,
      section: "Branch",
      sectionOrder: 1,
    }),
  ],
} satisfies PluginDefinition;
