import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import { deriveUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";
import {
  parsedJson,
  parsedText,
} from "@plugins/database/plugins/sql-column/server";
// The specific module, not the `core` barrel: drizzle-kit loads this file to
// build the schema, and the barrel also pulls the live-collection declarations.
import {
  LaneSchema,
  OpKindSchema,
  OpSleepSchema,
  OpSleepStampSchema,
  OpStepSchema,
  OpWaitSchema,
  OpenWaitSchema,
  PushModeSchema,
  StoreClosedBySchema,
  TerminalOutcomeSchema,
} from "../../core/internal/schemas";

// The op log's read model: one row per `op_id`, the reducer's `OpFoldState`
// flattened onto columns (see `OpRowSchema`). Written ONLY by the ingester
// (`ingest.ts` — every line of `op-log.jsonl`, applied through `applyOpEvent`)
// and by a worktree reconciler's `ingest-gap` close (`reconcile.ts`). The file
// stays the truth: this table is rebuilt from it, never the other way round.
//
// Per worktree DB: every serving backend ingests the one host-global file into
// its own DB, so a fork resumes from main's cursor instead of freezing main's
// in-flight rows at fork time.
export const _opLogOps = deriveUpdatedAt(
  pgTable(
    "op_log_ops",
    {
      opId: text("op_id").primaryKey(),
      kind: parsedText("kind", OpKindSchema).notNull(),
      opSlug: text("op_slug"),
      branch: text("branch").notNull(),
      conversationId: text("conversation_id"),
      lane: parsedText("lane", LaneSchema),
      mode: parsedText("mode", PushModeSchema),
      buildId: text("build_id"),
      pid: integer("pid"),
      requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
      grantedAt: timestamp("granted_at", { withTimezone: true }),
      // Null while in flight AND for a reconciler close (a killed op has no
      // real end) — so it is not the in-flight predicate; `closed_by` is.
      completedAt: timestamp("completed_at", { withTimezone: true }),
      outcome: parsedText("outcome", TerminalOutcomeSchema),
      interrupted: boolean("interrupted").notNull().default(false),
      closedBy: parsedText("closed_by", StoreClosedBySchema),
      waits: parsedJson("waits", z.array(OpWaitSchema)).notNull(),
      openWait: parsedJson("open_wait", OpenWaitSchema),
      cycle: integer("cycle").notNull().default(0),
      // Durations are ms from `performance.now()` differences — fractional.
      closedWaitMs: doublePrecision("closed_wait_ms").notNull().default(0),
      holdMs: doublePrecision("hold_ms").notNull().default(0),
      totalMs: doublePrecision("total_ms").notNull().default(0),
      steps: parsedJson("steps", z.array(OpStepSchema)).notNull(),
      lastSeq: integer("last_seq").notNull().default(0),
      // Wall-axis sleeps and the last sleep-clock stamp (see `OpFoldState`).
      // The default reads a row stored before the column as "no sleep seen".
      sleeps: parsedJson("sleeps", z.array(OpSleepSchema))
        .notNull()
        .default([]),
      sleepStamp: parsedJson("sleep_stamp", OpSleepStampSchema),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (t) => [
      index("op_log_ops_requested_idx").on(t.requestedAt.desc()),
      index("op_log_ops_slug_requested_idx").on(t.opSlug, t.requestedAt),
      index("op_log_ops_kind_requested_idx").on(t.kind, t.requestedAt),
      // The in-flight set: the `opsInFlight` set and the reconciler's
      // candidates. Partial, so it stays as small as what is running.
      index("op_log_ops_in_flight_idx")
        .on(t.requestedAt)
        .where(sql`${t.closedBy} IS NULL`),
    ],
  ),
  {
    touchedBy: {
      opId: false,
      kind: true,
      opSlug: true,
      branch: true,
      conversationId: true,
      lane: true,
      mode: true,
      buildId: true,
      pid: true,
      requestedAt: true,
      grantedAt: true,
      completedAt: true,
      outcome: true,
      interrupted: true,
      closedBy: true,
      waits: true,
      openWait: true,
      cycle: true,
      closedWaitMs: true,
      holdMs: true,
      totalMs: true,
      steps: true,
      lastSeq: true,
      sleeps: true,
      sleepStamp: true,
    },
  },
);

// How far into the op log this DB has ingested: one row per source file
// (`op-log`). `inode` names the physical file the offset is in — the live file
// is renamed to `.1` on rotation, so a path alone cannot say which bytes an
// offset counts. `offset` is always just past a `\n`: a partially-written last
// line is re-read on the next drain, never half-applied.
//
// `gap_at` is set when the ingester could not find its file among the live file
// and its rotations — some lines were never read, so a terminal may be missing.
// Committed in the SAME transaction as the rows the bytes produced, so the
// cursor and the rows can never disagree.
export const _opLogIngestCursor = deriveUpdatedAt(
  pgTable("op_log_ingest_cursor", {
    source: text("source").primaryKey(),
    // A decimal string: an inode is a u64, past a JS number's exact range.
    inode: text("inode").notNull(),
    offset: bigint("offset", { mode: "number" }).notNull(),
    gapAt: timestamp("gap_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  }),
  {
    touchedBy: { source: false, inode: true, offset: true, gapAt: true },
  },
);
