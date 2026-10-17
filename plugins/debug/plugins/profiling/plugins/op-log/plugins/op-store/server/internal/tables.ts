import { sql } from "drizzle-orm";
import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { deriveUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";
// The specific module, not the `core` barrel: drizzle-kit loads this file to
// build the schema, and the barrel also pulls the live-collection declarations.
import { opLogOpsEntityRef } from "../../core/internal/schemas";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";

// The op log's read model: one row per `op_id`, the reducer's `OpFoldState`
// flattened onto columns (see `OpRowSchema`). Written ONLY by the ingester
// (`ingest.ts` — every line of `op-log.jsonl`, applied through `applyOpEvent`)
// and by a worktree reconciler's `ingest-gap` close (`reconcile.ts`). The file
// stays the truth: this table is rebuilt from it, never the other way round.
//
// Per worktree DB: every serving backend ingests the one host-global file into
// its own DB, so a fork resumes from main's cursor instead of freezing main's
// in-flight rows at fork time.
const opLogOpsEntity = defineEntity(opLogOpsEntityRef, {
  primaryKey: "opId",
  columns: {
    interrupted: { default: false },
    cycle: { default: 0 },
    closedWaitMs: { default: 0 },
    holdMs: { default: 0 },
    totalMs: { default: 0 },
    lastSeq: { default: 0 },
    sleeps: { default: [] },
    updatedAt: { default: defaultNow() },
  },
  updatedAt: {
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
  indexes: (t) => [
    index("op_log_ops_requested_idx").on(t.requestedAt.desc()),
    index("op_log_ops_slug_requested_idx").on(t.opSlug, t.requestedAt),
    index("op_log_ops_kind_requested_idx").on(t.kind, t.requestedAt),
    // The in-flight set: the `opsInFlight` set and the reconciler's
    // candidates. Partial, so it stays as small as what is running.
    index("op_log_ops_in_flight_idx")
      .on(t.requestedAt)
      .where(sql`${t.closedBy} IS NULL`),
  ],
});
export const _opLogOps = opLogOpsEntity.table;

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
