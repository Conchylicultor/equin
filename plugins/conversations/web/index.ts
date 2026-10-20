import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { demoResource } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { serveDemoPartialMessage } from "./internal/demo-resource";

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
  contributions: [
    // Inside a demo scope, no agent is writing a message.
    demoResource("conversations", serveDemoPartialMessage),
  ],
} satisfies PluginDefinition;
