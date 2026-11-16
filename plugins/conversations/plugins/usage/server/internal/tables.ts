import { z } from "zod";
import {
  bigint,
  date,
  doublePrecision,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  parsedJson,
  parsedText,
} from "@plugins/database/plugins/sql-column/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import type { DayBucket } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import { conversationUsageShape } from "../../core";

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
export const DayBucketSchema: z.ZodType<DayBucket> = z.object({
  date: z.string(),
  // The UTC hour: every bucket counted since the fold kept hours (a row counted
  // before has day buckets, re-bucketed by hour on its next re-read — scan.ts).
  hour: z.number().int().min(0).max(23).optional(),
  model: z.string(),
  speed: z.enum(["standard", "fast"]),
  input: TieredSchema,
  output: TieredSchema,
  cacheRead: TieredSchema,
  cacheCreate5m: TieredSchema,
  cacheCreate1h: TieredSchema,
});

/**
 * One counted entry a file row remembers: its dedup hash, the bucket its tokens
 * went to and the output it counted (stats/cost's `SeenEntry`), so a later line
 * of the same message — read by the next append — can top its output up.
 */
const UsageTailEntrySchema = z.object({
  hash: z.string(),
  bucket: z.string().nullable(),
  output: z.number(),
});
export type UsageTailEntry = z.infer<typeof UsageTailEntrySchema>;

/**
 * A bare hash: a tail written before the fold counted each message at its
 * largest output (2026-10-28). Its row under-counts output, so the next sync
 * recounts it from the start (`isLegacyScan`) and writes entries (main held
 * none when the reprice job that reached them was deleted, 2026-11-16).
 */
const LegacyTailHashSchema = z.string();

export const UsageFileKindSchema = z.enum(["session", "subagent"]);
export type UsageFileKind = z.infer<typeof UsageFileKindSchema>;

// Scan state: one row per transcript file counted toward a conversation — how
// far it has been read (`offset`, always a line start) and the token buckets
// folded from those bytes. The buckets are what the sync takes each pass's
// token-ledger delta from (`tokenDelta(prev, next)` — a chain re-read can take
// tokens back), and what the one-shot history import files a conversation's
// pre-ledger count from; no reader sums them (the counts are in
// `claude_usage_hours`, the Cost column is derived from it).
//
// A row outlives its file on purpose: Claude Code deletes transcripts after
// `cleanupPeriodDays`, and a later re-read must not take back what the file
// counted. Rows go only with the conversation (FK CASCADE).
//
// `tailHashes` — the last entries the file counted (hash, bucket, output). The
// duplicate lines of one assistant message are adjacent, so this bounded tail
// is all an append read needs to dedupe — and top up — across a restart (the
// full seen-set is rebuilt only when a whole chain is re-read).
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
    tailHashes: parsedJson(
      "tail_hashes",
      z.array(z.union([UsageTailEntrySchema, LegacyTailHashSchema])),
    ).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.path] }),
    index("conversation_usage_files_conv_idx").on(t.conversationId),
  ],
);

// ─── Scan state of the transcripts no conversation owns ───────────────────────
//
// One row per transcript file the scanner (machine/) reads for the token
// ledger alone: every `<projects>/<dir>/<sessionId>.jsonl` no equin
// conversation has ever run under, and each of its sub-agents' transcripts —
// all filed under the session's `session:<sessionId>` source (`source`, also
// the ledger's). How far it has been read (`offset`, a line start) and its last
// counted entries (`tailHashes`, per-file dedup and top-ups across appends) —
// no buckets and no dollars: each read files the tokens it counted as a delta
// to `claude_usage_hours`, which is where the counts live.
//
// The design's `claude_transcript_scans` (research/2026-11-16-global-unified-
// claude-cost.md § 2) holds the transcripts `conversation_usage_files` does
// not (an equin conversation's files keep their rows there, buckets included —
// see above). A transcript is in at most one of the two: when a conversation adopts a
// session that was scanned here, its sync deletes the session's rows (and its
// ledger rows) in the write that counts the files under `conv:` (see
// machine/internal/session-sync.ts).
export const _claudeTranscriptScans = pgTable(
  "claude_transcript_scans",
  {
    path: text("path").primaryKey(),
    /** The ledger source its tokens are filed under (`session:<sessionId>`). */
    source: text("source").notNull(),
    kind: parsedText("kind", UsageFileKindSchema).notNull(),
    offset: bigint("offset", { mode: "number" }).notNull(),
    tailHashes: parsedJson(
      "tail_hashes",
      z.array(UsageTailEntrySchema),
    ).notNull(),
  },
  (t) => [index("claude_transcript_scans_source_idx").on(t.source)],
);

// ─── The history import's record ──────────────────────────────────────────────
//
// One row per one-shot import into the token ledger that has run against this
// database (machine/internal/history-import.ts): written in the transaction
// that files the import's rows, so an import is in the ledger exactly once —
// a second run (another boot, a concurrent one) finds the row and files
// nothing. A fork inherits it with the rows it describes.
export const UsageHistoryImportSummarySchema = z.object({
  /** Conversations whose pre-ledger count (`conversation_usage_files`) was filed. */
  conversations: z.number(),
  /** Archive entries filed (transcripts no scanner can read). */
  archiveEntries: z.number(),
  /** Archive entries skipped: on disk and counted by a scanner, or already in a scan row. */
  archiveSkipped: z.number(),
  /** Ledger rows the import wrote (`origin = 'imported'`). */
  rows: z.number(),
  /**
   * Of those, the rows filed under a real account: a conversation's hour the
   * legacy dollar ledger named exactly one account for
   * (`claude_usage_import_accounts`). The rest are `UNKNOWN_ACCOUNT`.
   */
  attributedRows: z.number(),
});
export type UsageHistoryImportSummary = z.infer<
  typeof UsageHistoryImportSummarySchema
>;

export const _claudeUsageHistoryImports = pgTable(
  "claude_usage_history_imports",
  {
    /** Which import (`USAGE_HISTORY_IMPORT`): a new import is a new name. */
    name: text("name").primaryKey(),
    importedAt: timestamp("imported_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    summary: parsedJson("summary", UsageHistoryImportSummarySchema).notNull(),
  },
);

// ─── Account spend the token ledger cannot hold ───────────────────────────────
//
// What each Claude account spent per UTC day BEFORE any spend was filed under
// what spent it: the legacy dollar ledger's `unattributed` rows (2026-11-13 →
// 2026-11-15, counted per account and day, never per conversation —
// research/2026-11-15-global-supervisors-spend-breakdown.md). Those dollars
// cannot become tokens (no source, no model), and the ledger's tokens of the
// same days are filed under `UNKNOWN_ACCOUNT` (no record says which account a
// conversation ran on then), so without this the account month chart would
// lose them. Carried over once, by the data migration that dropped that
// ledger (`…__usage_ledger_legacy_carryover.sql`), never written again; the account-spend read adds them
// to the ledger's priced hours. Frozen dollars on purpose — a fact with no
// tokens to re-price. A few rows per account, ever.
export const _claudeAccountSpendCarryover = pgTable(
  "claude_account_spend_carryover",
  {
    accountId: text("account_id").notNull(),
    /** The UTC day, `YYYY-MM-DD`. */
    day: date("day", { mode: "string" }).notNull(),
    costUsd: doublePrecision("cost_usd").notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.day] })],
);

// ─── The legacy dollar ledger's accounts, for the history import ──────────────
//
// Which Claude account each conversation hour was spent on, as the legacy
// dollar ledger (`claude_spend_hours`, 2026-11-15 23:00 → its drop) recorded
// it: one row per (`conv:` source, UTC hour) it filed under exactly ONE
// account. Copied by the data migration that dropped that ledger
// (`…__usage_ledger_legacy_carryover.sql`, before the drop, in the same
// migration group) so the one-shot history import — which runs after the
// boot that applied it — still attributes each imported remainder hour to its
// account (machine/internal/history-import.ts). Read by nothing else; drop it
// once main has recorded the import.
export const _claudeUsageImportAccounts = pgTable(
  "claude_usage_import_accounts",
  {
    /** A `conv:<conversationId>` source. */
    source: text("source").notNull(),
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    accountId: text("account_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.hour] })],
);
