import { z } from "zod";
import {
  bigint,
  doublePrecision,
  index,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import {
  parsedJson,
  parsedText,
} from "@plugins/database/plugins/sql-column/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import type { DayBucket } from "@plugins/stats/plugins/cost/core";
import { conversationUsageShape } from "../../shared/shape";

// The totals the conversation lists read (`conversations_ext_usage`, 1:1 on the
// conversation, FK CASCADE). Every column defaults to 0, so a conversation with
// no row yet reads 0 through the lists' LEFT join (COALESCE), in a sort and a
// filter as in the projection.
export const conversationUsage = defineExtension(
  _conversations,
  "usage",
  conversationUsageShape,
  {
    columns: {
      costUsd: { default: 0 },
      tokens: { default: 0 },
      cacheReadTokens: { default: 0 },
      agentCount: { default: 0 },
    },
  },
);
// drizzle-kit schema-glob discovery.
export const _conversationUsageExt = conversationUsage.table;

const TieredSchema = z.object({ below: z.number(), above: z.number() });
const DayBucketSchema: ZodParser<DayBucket> = z.object({
  date: z.string(),
  model: z.string(),
  speed: z.enum(["standard", "fast"]),
  input: TieredSchema,
  output: TieredSchema,
  cacheRead: TieredSchema,
  cacheCreate5m: TieredSchema,
  cacheCreate1h: TieredSchema,
});

export const UsageFileKindSchema = z.enum(["session", "subagent"]);
export type UsageFileKind = z.infer<typeof UsageFileKindSchema>;

// Scan state: one row per transcript file counted toward a conversation — how
// far it has been read (`offset`, always a line start) and the token buckets
// folded from those bytes. The conversation's totals are the sum of its rows.
//
// A row outlives its file on purpose: Claude Code deletes transcripts after
// `cleanupPeriodDays`, and the conversation's totals must not shrink when it
// does. Rows go only with the conversation (FK CASCADE).
//
// `tailHashes` — the last dedup hashes the file counted. The duplicate lines of
// one assistant message are adjacent, so this bounded tail is all an append
// read needs to dedupe across a restart (the full seen-set is rebuilt only when
// a whole chain is re-read).
//
// `costUsd` — the cost of the counted tokens, priced ONCE, when they were
// counted, with the price table of that moment: a later price-table refresh
// never re-prices history. `null` only on a row counted before costs were
// frozen, priced once by `conversations.usage.reprice`.
// `unpricedModels` — the models of this row's buckets the table could not price
// when they were counted (they add nothing to `costUsd`); the reprice after a
// price-table change prices them once the table knows them.
export const _conversationUsageFiles = pgTable(
  "conversation_usage_files",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => _conversations.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    kind: parsedText("kind", UsageFileKindSchema).notNull(),
    offset: bigint("offset", { mode: "number" }).notNull(),
    buckets: parsedJson("buckets", z.array(DayBucketSchema)).notNull(),
    tailHashes: parsedJson("tail_hashes", z.array(z.string())).notNull(),
    costUsd: doublePrecision("cost_usd"),
    unpricedModels: parsedJson("unpriced_models", z.array(z.string()))
      .notNull()
      .default([]),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.path] }),
    index("conversation_usage_files_conv_idx").on(t.conversationId),
  ],
);
