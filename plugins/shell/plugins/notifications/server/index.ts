import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromFork } from "@plugins/database/plugins/admin/server";
import {
  notificationsServed,
  notificationsUnreadServed,
} from "./internal/resources";
import { _notifications } from "./internal/tables";
import { handleCreate } from "./internal/handle-create";
import { handleDismiss } from "./internal/handle-dismiss";
import { handleDismissAll } from "./internal/handle-dismiss-all";
import { handleMarkAllRead } from "./internal/handle-mark-read";
import { ttlCleanupJob } from "./internal/ttl-cleanup";
import {
  createNotification,
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
  description: "Persistent bell-button notifications backed by the DB.",
  contributions: [
    IdKinds.Kind({ kind: notificationIdKind }),
    ...notificationsServed.declare,
    ...notificationsUnreadServed.declare,
    // The sharpest case in the whole exclusion set. A notification has NO
    // worktree column, the resource is boot-critical and read unscoped, and
    // `ttlCleanupJob` declares no `perWorktree` so it runs on main only. A
    // forked worktree therefore shows main's undismissed notifications — build
    // failures, fork-failed notices, crash reports pointing at main's tasks — in
    // its own bell from first boot, and nothing in that fork ever sweeps them.
    ExcludeFromFork({
      table: _notifications,
      reason:
        "No worktree column, read unscoped, and the TTL sweep is main-only — inherited rows show main's bell in a fresh worktree forever.",
    }),
  ],
  // ttlCleanupJob declares `schedule` — the jobs worker seeds its cron item at
  // startup, so no onReady enqueue is needed.
  register: [ttlCleanupJob],
  httpRoutes: {
    [createNotification.route]: handleCreate,
    [dismissAllNotifications.route]: handleDismissAll,
    [markAllNotificationsRead.route]: handleMarkAllRead,
    [dismissNotification.route]: handleDismiss,
  },
} satisfies ServerPluginDefinition;
