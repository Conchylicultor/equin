import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";

/**
 * The one reminder a conversation got for a stop its gates would have
 * blocked (`./backstop.ts`) — at most one per conversation (the PK), so the
 * backstop is a bounded nudge, never a loop. The turn id is minted with the
 * row, so a retried delivery repeats the same turn (`submitTurn` no-ops on a
 * known id).
 */
export const _stopGateReminders = pgTable("stop_gate_reminders", {
  conversationId: text("conversation_id")
    .primaryKey()
    .references(() => _conversations.id, { onDelete: "cascade" }),
  turnId: text("turn_id").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});
