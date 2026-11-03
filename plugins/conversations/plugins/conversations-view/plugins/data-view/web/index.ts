import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { SidebarSources } from "./host";
import { conversationListConfig } from "../shared/config";

export { SidebarSources, SIDEBAR_VIEW } from "./host";
export type { ConversationSidebarProps } from "./host";
export { ConversationsSidebarDataView } from "./components/conversations-sidebar-data-view";
export {
  SidebarConversationDot,
  SidebarConversationItem,
} from "./components/sidebar-conversation-item";

export default {
  description:
    "Umbrella for the DataView conversation-list sidebar: owns the merged multi-source DataView surface (one config, one unified switcher) mounted directly by the conversations-view mount point. Per-source sub-plugins (Queue, History) contribute into SidebarSources and name their rows through SidebarConversationItem, which reads the Conversation list title setting (conversation / task / short task title).",
  contributions: [ConfigV2.WebRegister({ descriptor: conversationListConfig })],
  slots: { sources: SidebarSources },
} satisfies PluginDefinition;
