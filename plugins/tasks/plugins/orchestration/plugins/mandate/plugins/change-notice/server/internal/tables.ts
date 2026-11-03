import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";

/**
 * A mandate-change notice a running agent has not been sent yet — at most one
 * per conversation (a later change replaces it; the notice renders the
 * mandate as it is when sent). The turn id is minted with the row, so a
 * retried delivery repeats the same turn (`submitTurn` no-ops on a known id).
 */
export const _conversationMandateNotices = pgTable(
  "conversation_mandate_notices",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => _conversations.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);
