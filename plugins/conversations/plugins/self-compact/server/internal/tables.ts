import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";

/**
 * A compaction an agent asked for and has not been sent yet — at most one per
 * conversation (a second request replaces the first). The two turn ids are
 * minted with the request, so a retried delivery repeats the same turns
 * (`submitTurn` no-ops on a known id) instead of compacting twice.
 */
export const _conversationCompactions = pgTable("conversation_compactions", {
  conversationId: text("conversation_id")
    .primaryKey()
    .references(() => _conversations.id, { onDelete: "cascade" }),
  /** The `/compact` instructions: what the summary must keep. */
  keep: text("keep").notNull(),
  /** What the agent continues with once compacted. */
  next: text("next").notNull(),
  compactTurnId: text("compact_turn_id").notNull(),
  nextTurnId: text("next_turn_id").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
