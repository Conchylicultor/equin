import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { OpenCommitConversation } from "./internal/open-commit-conversation";

export default {
  description:
    "The commit row action that opens the conversation which wrote a commit (its Singularity-Conversation trailer) in a new browser tab.",
  contributions: [],
} satisfies PluginDefinition;
