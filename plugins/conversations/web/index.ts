import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  useConversations,
  useConversation,
  useConversationById,
  useLiveConversation,
  useHasActiveSiblings,
  useHasActiveSiblingInWorktree,
  useActiveConversations,
  useConversationTitleBySlug,
} from "./use-conversations";
export default {
  collapsed: true,
  description: "Conversation domain: shared hooks and client-side API.",
  loadBearing: true,
} satisfies PluginDefinition;
