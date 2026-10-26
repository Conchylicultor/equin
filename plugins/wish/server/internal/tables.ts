import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Tracks which conversation group a submitted task should be added to once its
// conversation is created. Written at submit time; cleared by applyGroupJob
// when the conversationCreated event fires for the task.
export const _improvePendingGroups = pgTable("improve_pending_groups", {
  taskId: text("task_id").primaryKey(),
  groupId: text("group_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
