import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SidebarSources } from "@plugins/conversations/plugins/conversations-view/plugins/data-view/web";
import {
  HistorySource,
  HistoryItemActions,
  CloseConvAction,
} from "./components/sidebar-history";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Contributes the History list (a live source over the `conversations.history` collection) as the History source of the merged conversation-sidebar DataView.",
  contributions: [
    SidebarSources({
      id: "history",
      title: "History",
      icon: symbol("history"),
      order: 10,
      views: ["list"],
      component: HistorySource,
    }),
    HistoryItemActions({ id: "close", component: CloseConvAction }),
  ],
  slots: { historyActions: HistoryItemActions },
} satisfies PluginDefinition;
