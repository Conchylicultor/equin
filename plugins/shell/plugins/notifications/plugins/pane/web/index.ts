import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  DismissNotificationAction,
  NotificationItemActions,
  OpenNotificationAction,
} from "./components/notifications-view";
import { notificationsPane } from "./panes";

export default {
  description:
    "Debug → Notifications: every undismissed notification as a DataView (the bell popover's View all), with Open / Dismiss row actions. Its own plugin so the notifications plugin (and its useToast) never imports data-view — data-view raises toasts itself.",
  contributions: [
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
