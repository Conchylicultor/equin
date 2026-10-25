import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { z } from "zod";
import {
  AUDIENCES,
  reachesAudience,
  type Audience,
} from "@plugins/audience/core";
import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import { filterSql } from "@plugins/network/plugins/live/plugins/filter/server";
import { _notifications } from "./tables";
import { notifications, notificationsUnread } from "../../shared/resources";
import {
  NotificationVariantSchema,
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

// One row per (declared audience, variant) the unread rows hold.
const UnreadGroupSchema = z.object({
  audience: z.enum(AUDIENCES),
  variant: NotificationVariantSchema,
  n: z.number().int().nonnegative(),
});

/**
 * The badge's counts over the WHOLE collection (not the loaded window), per
 * audience: the unread rows grouped by their declared audience, then folded
 * into each reader audience through `reachesAudience` — the same rule the
 * bell's `audienceScope` filters its reads by. The partial index
 * `notifications_unread_badge_idx` covers exactly this predicate.
 *
 * db-parametrized so the DB-backed suite drives it against a throwaway
 * Postgres; production passes nothing and gets the app pool.
 */
export async function countUnreadNotifications(
  conn: NodePgDatabase = db,
): Promise<NotificationsUnread> {
  const groups = await executeRows(conn, {
    query: sql`SELECT ${_notifications.audience} AS audience,
        ${_notifications.variant} AS variant, count(*)::int AS n
      FROM ${_notifications}
      WHERE ${and(undismissed, countedUnreadSql)}
      GROUP BY 1, 2`,
    row: UnreadGroupSchema,
    label: "notifications.unread",
  });
  const counts = (reader: Audience) => {
    const reaching = groups.filter((g) => reachesAudience(g.audience, reader));
    const sum = (variant: string) =>
      reaching
        .filter((g) => g.variant === variant)
        .reduce((total, g) => total + g.n, 0);
    return { errors: sum("error"), warnings: sum("warning") };
  };
  return Object.fromEntries(
    AUDIENCES.map((reader) => [reader, counts(reader)]),
  ) as NotificationsUnread;
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
