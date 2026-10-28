import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { idColumn } from "@plugins/ids/server";
import { conversationFlagIdKind } from "../../core";
import {
  _conversations,
  _tasks,
} from "@plugins/tasks/plugins/tasks-core/server";

/**
 * Every flag an agent raised (`flag_raise`): what it wants a person to know,
 * on which task. Append-only; both FKs cascade.
 */
export const _conversationFlags = pgTable(
  "conversation_flags",
  {
    id: idColumn(conversationFlagIdKind, { sqlDefault: true }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => _conversations.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => _tasks.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("conversation_flags_conversation_idx").on(t.conversationId)],
);
