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
import { Notifications, openAction, reloadAction } from "./internal/actions";

export { useToast, type Toast, type ToastArgs } from "./internal/toast";
export { useNotificationArrivals } from "./internal/use-notification-arrivals";
export type { Notification } from "../shared/resources";
export {
  Notifications,
  type NotificationActionControlProps,
  type NotificationActionKind,
} from "./internal/actions";

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
    // The action kinds this plugin owns; others contribute their own.
    Notifications.Action(openAction),
    Notifications.Action(reloadAction),
  ],
  slots: {
    notifications: notificationsPane,
    notificationActions: NotificationItemActions,
    action: Notifications.Action,
  },
} satisfies PluginDefinition;
