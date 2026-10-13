import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { broadcastsPane } from "./panes";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  BroadcastItemActions,
  DeleteBroadcastAction,
} from "./components/broadcast-item-actions";

export { broadcastsPane } from "./panes";

export default {
  description:
    "View and edit the CLI's broadcasts.json (plugins/framework/plugins/cli/broadcasts.json in the main checkout): the broadcast messages printed on stale worktrees.",
  contributions: [
    Pane.Register({ pane: broadcastsPane }),
    DebugApp.Sidebar({
      id: "broadcasts",
      title: "Broadcasts",
      icon: symbol("feedback"),
      opens: { pane: broadcastsPane, params: {} },
    }),
    BroadcastItemActions({ id: "delete", component: DeleteBroadcastAction }),
  ],
  slots: {
    "debug-broadcasts": broadcastsPane,
    itemActions: BroadcastItemActions,
  },
} satisfies PluginDefinition;
