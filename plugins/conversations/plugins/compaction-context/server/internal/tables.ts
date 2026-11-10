import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// The compaction context last handed to each conversation's hook, kept until
// `compaction-context/delivery-check` has read back from the transcript
// whether the agent got it whole. One row per conversation (a later compaction
// overwrites it); the check deletes it once decided, so the table holds only
// the compactions still being checked.
//
// `conversation_id` has no foreign key: the row is about an agent session, and
// the hook names it by the id it was launched with.
export const _compactionContextSends = pgTable("compaction_context_sends", {
  conversationId: text("conversation_id").primaryKey(),
  /** The exact text the endpoint answered — what the transcript must show. */
  context: text("context").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
});
