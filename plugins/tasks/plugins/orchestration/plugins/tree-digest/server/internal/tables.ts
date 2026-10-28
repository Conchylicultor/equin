import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import {
  _conversations,
  _tasks,
} from "@plugins/tasks/plugins/tasks-core/server";

/**
 * How far each conversation has seen its mandate's task tree: the digest it
 * was last shown covered every change up to `seen_at`. Keyed by root too, so a
 * conversation whose mandate root moves (its task re-filed) starts over with
 * the whole new tree. A write stamp, not a derived `updated_at`; both FKs
 * cascade, so a cursor never outlives its conversation or its root.
 */
export const _digestCursors = pgTable(
  "digest_cursors",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => _conversations.id, { onDelete: "cascade" }),
    rootTaskId: text("root_task_id")
      .notNull()
      .references(() => _tasks.id, { onDelete: "cascade" }),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.rootTaskId] })],
);
