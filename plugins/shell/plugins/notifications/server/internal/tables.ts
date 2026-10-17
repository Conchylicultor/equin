import { index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { nullable } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import { notificationsEntityRef } from "../../core/entity";

// Built from `notificationFields` (core/entity.ts). `dedupKey` is the server
// field: the producer's collapse key, never on the wire.
const notificationsEntity = defineEntity(
  notificationsEntityRef,
  { dedupKey: nullable(textField()) },
  {
    primaryKey: "id",
    columns: {
      dismissed: { default: false },
      read: { default: false },
      muted: { default: false },
      count: { default: 1 },
      lastSeenAt: { default: defaultNow() },
      createdAt: { default: defaultNow() },
    },
    indexes: (t) => [
      index("notifications_dismissed_idx").on(t.dismissed),
      index("notifications_created_at_idx").on(t.createdAt),
      index("notifications_last_seen_at_idx").on(t.lastSeenAt),
      uniqueIndex("notifications_dedup_key_idx").on(t.dedupKey),
      // The bell's badge (`notifications.unread`) recounts on every write to
      // this table; this partial index holds exactly the rows it counts
      // (`countedUnread` minus its variant test, plus the base membership).
      index("notifications_unread_badge_idx")
        .on(t.variant)
        .where(
          sql`${t.dismissed} = false AND ${t.read} = false AND ${t.muted} = false`,
        ),
    ],
  },
);

export const _notifications = notificationsEntity.table;
