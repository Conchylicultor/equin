import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Item as ItemSlots } from "./slots";

export {
  ConversationItem,
  ConvStatusDot,
  ConvSysBadge,
  ConvTitle,
  ConvRelativeTime,
  conversationTitle,
  type ConversationItemConv,
  type ConversationItemProps,
  type ConvTitleOverride,
} from "./components/conversation-item";
export { convStatusDot, convStatusOnlyDot } from "./components/conv-status-dot";
export { Item } from "./slots";

export default {
  description:
    "Visual primitive for rendering a Conversation as a row or inline chip. Used by every surface that lists conversations.",
  contributions: [],
  slots: ItemSlots,
} satisfies PluginDefinition;
