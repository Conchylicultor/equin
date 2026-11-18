import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { BellButton } from "./components/bell-button";
import { IdKinds } from "@plugins/ids/web";
import { notificationIdKind } from "../core";
import { Notifications, openAction, reloadAction } from "./internal/actions";

export { useToast, type Toast, type ToastArgs } from "./internal/toast";
export type { LiveToastAction } from "./components/notification-view";
export { notifications } from "../shared/resources";
export {
  dismissAllNotifications,
  dismissNotification,
  markAllNotificationsRead,
} from "../shared/endpoints";
export { useNotificationArrivals } from "./internal/use-notification-arrivals";
export type { Notification } from "../shared/resources";
export {
  Notifications,
  type NotificationActionControlProps,
  type NotificationActionKind,
} from "./internal/actions";

export default {
  description:
    "Persistent bell-button notifications backed by the DB, and the one toast API: useToast() shows a toast and records it in the notification history (a liveAction — an Undo closure — is drawn on the live toast only).",
  contributions: [
    IdKinds.Kind({ kind: notificationIdKind }),
    ActionBar.Item({
      id: "notifications",
      component: BellButton,
    }),
    // The action kinds this plugin owns; others contribute their own.
    Notifications.Action(openAction),
    Notifications.Action(reloadAction),
  ],
  slots: {
    action: Notifications.Action,
  },
} satisfies PluginDefinition;
