import { index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { nullable } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import { notificationsEntityRef } from "../../core";

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
      audience: { default: "user" },
      category: { default: "other" },
      count: { default: 1 },
      lastSeenAt: { default: defaultNow() },
      createdAt: { default: defaultNow() },
      // `state.tone`, derived — so it can never disagree with `state`, which
      // its writers (`writeNotification`, `restateByMetadata`) set alone.
      stateTone: { generated: () => sql`state ->> 'tone'` },
    },
    indexes: (t) => [
      // The collection's window (`resources.ts`: `dismissed = $1`, ordered by
      // `createdAt` desc nulls last, `id` asc as tiebreak) read off this index
      // in order, a page's rows only: without it every load scanned and sorted
      // the whole table (main, 2026-11-18: 13k rows for a 200-row page, ~6 ms
      // idle and up to 0.5–1.7 s under a restart replay, holding a read slot).
      // Leading with `dismissed`, it also serves every `dismissed`-only filter.
      index("notifications_window_idx").on(
        t.dismissed,
        t.createdAt.desc().nullsLast(),
        t.id,
      ),
      index("notifications_created_at_idx").on(t.createdAt),
      index("notifications_last_seen_at_idx").on(t.lastSeenAt),
      uniqueIndex("notifications_dedup_key_idx").on(t.dedupKey),
      // The bell's badge (`notifications.unread`) recounts on every write to
      // this table; this partial index holds exactly the rows it counts
      // (`countedUnread` minus its variant test, plus the base membership).
      index("notifications_unread_badge_idx")
        .on(t.variant, t.audience)
        .where(
          sql`${t.dismissed} = false AND ${t.read} = false AND ${t.muted} = false`,
        ),
    ],
  },
);

export const _notifications = notificationsEntity.table;
