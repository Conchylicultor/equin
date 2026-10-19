import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { autoAnswerConfig, runtimeConfig } from "../shared/config";

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
    ConfigV2.WebRegister({ descriptor: autoAnswerConfig }),
    ConfigV2.WebRegister({ descriptor: runtimeConfig }),
  ],
} satisfies PluginDefinition;
