import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { BellButton } from "./components/bell-button";
import {
  DismissNotificationAction,
  NotificationItemActions,
  OpenNotificationAction,
} from "./components/notifications-view";
import { notificationsPane } from "./panes";
import { IdKinds } from "@plugins/ids/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { notificationIdKind } from "../core";

export { toast, type ToastArgs } from "./internal/toast";

export default {
  description:
    "Persistent bell-button notifications backed by the DB, and Debug → Notifications: every undismissed notification as a DataView (the bell popover's View all).",
  contributions: [
    IdKinds.Kind({ kind: notificationIdKind }),
    ActionBar.Item({
      id: "notifications",
      component: BellButton,
    }),
    Pane.Register({ pane: notificationsPane }),
    // The in-app entry point for the pane the bell's "View all" opens.
    DebugApp.Sidebar({
      id: "notifications",
      title: "Notifications",
      icon: symbol("notifications"),
      opens: { pane: notificationsPane, params: {} },
    }),
    NotificationItemActions({ id: "open", component: OpenNotificationAction }),
    NotificationItemActions({
      id: "dismiss",
      component: DismissNotificationAction,
    }),
  ],
  slots: {
    notifications: notificationsPane,
    notificationActions: NotificationItemActions,
  },
} satisfies PluginDefinition;
