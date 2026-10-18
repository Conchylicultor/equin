import { index } from "drizzle-orm/pg-core";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import { conversationSummariesEntityRef } from "../../core";

// Append-only summary rows — one row per "Summarize" press, never updated.
// Soft FK to conversations (text id, no cascade): the model decides when
// to summarise from outside the conversation lifecycle, and we keep
// historical rows even after a conversation is deleted (sweep later if
// needed). Composite index supports "latest summary for conversation X"
// and "all rows ordered newest-first for monitoring".
//
// The table + the `ConversationSummary` wire schema both derive from the single
// `conversationSummaryFields` record (core), so a column/schema drift is
// unrepresentable.
const conversationSummaries = defineEntity(conversationSummariesEntityRef, {
  primaryKey: "id",
  columns: {
    generatedAt: { default: defaultNow() },
  },
  indexes: (t) => [
    index("conversation_summaries_by_conv_idx").on(
      t.conversationId,
      t.generatedAt,
    ),
  ],
});

// drizzle-kit schema-glob discovery. Name kept so consumers don't churn.
export const _conversationSummaries = conversationSummaries.table;
