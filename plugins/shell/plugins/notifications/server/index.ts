import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  notificationsServed,
  notificationsUnreadServed,
} from "./internal/resources";
import { handleDismiss } from "./internal/handle-dismiss";
import { handleDismissAll } from "./internal/handle-dismiss-all";
import { handleMarkAllRead } from "./internal/handle-mark-read";
import { ttlCleanupJob } from "./internal/ttl-cleanup";
import {
  dismissAllNotifications,
  markAllNotificationsRead,
  dismissNotification,
} from "../shared/endpoints";
import { IdKinds } from "@plugins/ids/server";
import { notificationIdKind } from "../core";

export { _notifications } from "./internal/tables";
export { recordNotification } from "./internal/record-notification";
export type { RecordNotificationInput } from "./internal/record-notification";
export { setMutedByMetadata } from "./internal/reclassify-muted";

export default {
  portable: true,
  description:
    "Persistent bell-button notifications backed by the DB (the fork exclusion of its table is the machine half's).",
  contributions: [
    IdKinds.Kind({ kind: notificationIdKind }),
    ...notificationsServed.declare,
    ...notificationsUnreadServed.declare,
  ],
  // ttlCleanupJob declares `schedule` — the jobs worker seeds its cron item at
  // startup, so no onReady enqueue is needed.
  register: [ttlCleanupJob],
  httpRoutes: {
    [dismissAllNotifications.route]: handleDismissAll,
    [markAllNotificationsRead.route]: handleMarkAllRead,
    [dismissNotification.route]: handleDismiss,
  },
} satisfies ServerPluginDefinition;
