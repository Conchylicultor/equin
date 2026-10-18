import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "@plugins/database/server";
import { executeOne } from "@plugins/database/plugins/sql-rows/core";
import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import { filterSql } from "@plugins/network/plugins/live/plugins/filter/server";
import { _notifications } from "./tables";
import { notifications, notificationsUnread } from "../../shared/resources";
import {
  NotificationsUnreadSchema,
  type NotificationsUnread,
} from "../../shared/schema";
import { countedUnread, countedUnreadFilterable } from "../../shared/unread";

// The collection IS the undismissed rows: `dismissed = false` is the base
// membership, ANDed into the window, the `:rows` point reads and every grouping,
// so a dismiss is a membership exit (a real delete in the window delta) and a
// recount of the groups. The projection is derived from the collection's fields, so
// the server-internal `dedupKey` can never reach the wire. `createdAt` is the one
// sortable column: a resurface (which bumps it) is re-floated via one bounded ids
// query, while a count/lastSeenAt-only dedup bump stays an in-place upsert.
const undismissed = eq(_notifications.dismissed, false);

export const notificationsServed = serveCollection(notifications, {
  from: _notifications,
  where: undismissed,
});

// `countedUnread` compiled once: the same predicate the panel tests in memory.
const countedUnreadSql = filterSql(
  countedUnread,
  {
    read: sql`${_notifications.read}`,
    muted: sql`${_notifications.muted}`,
    variant: sql`${_notifications.variant}`,
  },
  countedUnreadFilterable,
);

/**
 * The badge's counts over the WHOLE collection (not the loaded window). One
 * aggregate row always comes back; `executeOne` throws if it does not, so a
 * missing row can never read as "no unread". The partial index
 * `notifications_unread_badge_idx` covers exactly this predicate.
 *
 * db-parametrized so the DB-backed suite drives it against a throwaway
 * Postgres; production passes nothing and gets the app pool.
 */
export async function countUnreadNotifications(
  conn: NodePgDatabase = db,
): Promise<NotificationsUnread> {
  return executeOne(conn, {
    query: sql`SELECT
        count(*) FILTER (WHERE ${_notifications.variant} = 'error')::int AS errors,
        count(*) FILTER (WHERE ${_notifications.variant} = 'warning')::int AS warnings
      FROM ${_notifications}
      WHERE ${and(undismissed, countedUnreadSql)}`,
    row: NotificationsUnreadSchema,
    label: "notifications.unread",
  });
}

// A whole-table value: recomputed (and pushed whole) on every write to
// `notifications`, which the declared `reads` below route here.
export const notificationsUnreadServed = serveValue(notificationsUnread, {
  source: "db",
  reads: {
    tables: [_notifications],
    reason:
      "the badge counts every unread, undismissed row, so a write to any notification may change the counts",
  },
  loader: () => countUnreadNotifications(),
  // Every write to `notifications` re-runs the count. A burst (a build or a
  // crash storm filing hundreds of rows) is one count per window, not one per
  // insert, which measured ~16 no-op pushes/s while 700 rows were seeded.
  throttleMs: 250,
});
