import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { parsedJson } from "@plugins/database/plugins/sql-column/server";
import { idColumn } from "@plugins/ids/server";
import { conversationFlagIdKind, FlagItemsSchema } from "../../core";
import {
  _conversations,
  _tasks,
} from "@plugins/tasks/plugins/tasks-core/server";

/**
 * Every flag an agent raised (`flag_raise`): what it needs a person to act on
 * (`items`) and the evidence behind it (`details`), on which task
 * (`../../core/flag.ts`). Append-only; both FKs cascade.
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
    items: parsedJson("items", FlagItemsSchema).notNull(),
    details: text("details"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("conversation_flags_conversation_idx").on(t.conversationId)],
);
