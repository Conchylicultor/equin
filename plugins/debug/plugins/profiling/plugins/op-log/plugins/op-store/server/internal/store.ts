import { eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { executeOne } from "@plugins/database/plugins/sql-rows/core";
import {
  applyOpEvent,
  sumWaits,
  type OpFoldState,
  type OpLine,
} from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import {
  LANES,
  PUSH_MODES,
  TERMINAL_OUTCOMES,
  WAIT_KIND_IDS,
  opRowToFoldState,
  type OpRow,
} from "../../core/internal/schemas";
import type { IngestCursor } from "./segments";
import { _opLogIngestCursor, _opLogOps } from "./tables";

// The DB half of one ingest batch: under one transaction-scoped advisory lock,
// check the cursor is where the reader started, fold the batch's lines into the
// rows they touch, upsert them, and advance the cursor — all or nothing, so the
// cursor never counts bytes whose rows were not written (or vice versa).

export type OpStoreDb = NodePgDatabase;
type Tx = Parameters<Parameters<OpStoreDb["transaction"]>[0]>[0];

/** The one cursor row this store keeps (the live `op-log.jsonl` and its rotations). */
export const OP_LOG_SOURCE = "op-log";

export interface StoredCursor extends IngestCursor {
  gapAt: Date | null;
}

export async function readCursor(
  exec: OpStoreDb | Tx,
): Promise<StoredCursor | null> {
  const [row] = await exec
    .select({
      inode: _opLogIngestCursor.inode,
      offset: _opLogIngestCursor.offset,
      gapAt: _opLogIngestCursor.gapAt,
    })
    .from(_opLogIngestCursor)
    .where(eq(_opLogIngestCursor.source, OP_LOG_SOURCE));
  return row ?? null;
}

function sameCursor(a: IngestCursor | null, b: IngestCursor | null): boolean {
  if (a === null || b === null) return a === b;
  return a.inode === b.inode && a.offset === b.offset;
}

// A lock id private to this store; transaction-scoped, so PgBouncer's
// transaction pooling keeps it sound.
const LOCK_SQL = sql`SELECT pg_try_advisory_xact_lock(hashtext('op-store:ingest')) AS ok`;

async function tryLock(tx: Tx): Promise<boolean> {
  const { ok } = await executeOne(tx, {
    query: LOCK_SQL,
    row: z.object({ ok: z.boolean() }),
  });
  return ok;
}

// ── state ↔ row ─────────────────────────────────────────────────────────────

/**
 * Keep an enum field inside its closed set. The op log is shared by every
 * checkout on the host, and a worktree on NEWER code may write a value this
 * backend's code has never heard of — refusing it would wedge this DB's ingest
 * forever on one line. So the value is mapped to a fallback, loudly.
 */
function known<T extends string>(
  set: readonly T[],
  value: T,
  fallback: T,
  what: string,
  opId: string,
): T {
  if (set.includes(value)) return value;
  console.warn(
    `[op-store] op ${opId}: unknown ${what} ${JSON.stringify(value)} — stored as ${JSON.stringify(fallback)}`,
  );
  return fallback;
}

function knownOrNull<T extends string>(
  set: readonly T[],
  value: T | null,
  what: string,
  opId: string,
): T | null {
  if (value === null || set.includes(value)) return value;
  console.warn(
    `[op-store] op ${opId}: unknown ${what} ${JSON.stringify(value)} — stored as null`,
  );
  return null;
}

type OpInsert = typeof _opLogOps.$inferInsert;

/**
 * The row a folded state persists as, or `null` for a state that cannot be a
 * row yet: a HEADLESS op (its `requested` line was clipped by the seed tail and
 * no self-contained terminal has arrived) has no identity to store. It is
 * re-folded from nothing on each batch until its terminal lands.
 */
export function stateToRow(s: OpFoldState): OpInsert | null {
  if (s.identity === null || s.requestedAt === null) return null;
  const id = s.opId;
  const waits = s.waits.filter((w) => {
    if (WAIT_KIND_IDS.includes(w.kind)) return true;
    console.warn(
      `[op-store] op ${id}: dropped a wait of unknown kind ${JSON.stringify(w.kind)}`,
    );
    return false;
  });
  const openWait =
    s.openWait && WAIT_KIND_IDS.includes(s.openWait.kind) ? s.openWait : null;
  return {
    opId: id,
    kind: s.identity.kind,
    opSlug: s.identity.opSlug,
    branch: s.identity.branch,
    conversationId: s.identity.conversationId,
    lane: knownOrNull(LANES, s.identity.lane, "lane", id),
    mode: knownOrNull(PUSH_MODES, s.identity.mode, "mode", id),
    buildId: s.identity.buildId,
    pid: s.identity.pid,
    opportunistic: s.identity.opportunistic,
    requestedAt: new Date(s.requestedAt),
    grantedAt: s.grantedAt === null ? null : new Date(s.grantedAt),
    completedAt: s.completedAt === null ? null : new Date(s.completedAt),
    outcome:
      s.outcome === null
        ? null
        : known(TERMINAL_OUTCOMES, s.outcome, "error", "outcome", id),
    interrupted: s.interrupted,
    closedBy: s.closedBy,
    waits,
    openWait,
    cycle: s.cycle,
    closedWaitMs: sumWaits(waits),
    holdMs: s.holdMs,
    totalMs: s.totalMs,
    steps: s.steps,
    lastSeq: s.lastSeq,
    sleeps: s.sleeps,
    sleepStamp: s.sleepStamp,
  };
}

// Every column an upsert rewrites: all but the key and the derived `updated_at`.
const UPSERT_SET = Object.fromEntries(
  Object.entries(getTableColumns(_opLogOps))
    .filter(([key]) => key !== "opId" && key !== "updatedAt")
    .map(([key, col]) => [key, sql.raw(`excluded."${col.name}"`)]),
);

/** Rows per INSERT: 26 columns each, far under Postgres' 65535 bind params. */
const UPSERT_CHUNK = 500;
/** Ids per `IN (…)` lookup. */
const LOOKUP_CHUNK = 1000;

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function loadRows(tx: Tx, opIds: readonly string[]): Promise<OpRow[]> {
  const cols = getTableColumns(_opLogOps);
  const { updatedAt: _updatedAt, ...select } = cols;
  const out: OpRow[] = [];
  for (const ids of chunks(opIds, LOOKUP_CHUNK)) {
    const rows = await tx
      .select(select)
      .from(_opLogOps)
      .where(inArray(_opLogOps.opId, ids));
    out.push(...rows);
  }
  return out;
}

/**
 * Fold `lines` into the rows they touch. Pure over its inputs: `stored` is the
 * rows as loaded. Returns the rows to write — only ops whose state actually
 * changed (the reducer returns the same object for an ignored line), and never
 * a row already closed in the DB (a terminal wins, including a local
 * `ingest-gap` close the reducer's two-valued `closedBy` cannot express).
 */
export function foldBatch(
  stored: readonly OpRow[],
  lines: readonly OpLine[],
): OpInsert[] {
  const closed = new Set<string>();
  const before = new Map<string, OpFoldState>();
  for (const row of stored) {
    if (row.closedBy !== null) closed.add(row.opId);
    else before.set(row.opId, opRowToFoldState(row));
  }
  const after = new Map(before);
  for (const line of lines) {
    if (closed.has(line.opId)) continue;
    after.set(line.opId, applyOpEvent(after.get(line.opId), line));
  }
  const out: OpInsert[] = [];
  for (const [opId, state] of after) {
    if (before.get(opId) === state) continue; // nothing applied
    const row = stateToRow(state);
    if (row) out.push(row);
  }
  return out;
}

export type BatchOutcome =
  /** Committed: rows written and the cursor advanced. */
  | { kind: "ok"; written: number }
  /** Another process holds the ingest lock on this DB; it is draining. */
  | { kind: "busy" }
  /** The cursor moved under us since the pass read it; re-plan. */
  | { kind: "moved" };

/**
 * Apply one batch: `lines` read from `[expected.offset, next.offset)` of the
 * file `next.inode` (or a segment boundary — `lines` may be empty).
 * `gap` stamps `gap_at = now` on the cursor.
 */
export async function commitBatch(
  conn: OpStoreDb,
  batch: {
    expected: IngestCursor | null;
    next: IngestCursor;
    lines: readonly OpLine[];
    gap: boolean;
  },
): Promise<BatchOutcome> {
  return conn.transaction(async (tx) => {
    if (!(await tryLock(tx))) return { kind: "busy" };
    const current = await readCursor(tx);
    if (!sameCursor(current, batch.expected)) return { kind: "moved" };

    const opIds = [...new Set(batch.lines.map((l) => l.opId))];
    const stored = opIds.length > 0 ? await loadRows(tx, opIds) : [];
    const rows = foldBatch(stored, batch.lines);
    for (const part of chunks(rows, UPSERT_CHUNK)) {
      await tx
        .insert(_opLogOps)
        .values(part)
        .onConflictDoUpdate({ target: _opLogOps.opId, set: UPSERT_SET });
    }

    const gapAt = batch.gap ? new Date() : (current?.gapAt ?? null);
    await tx
      .insert(_opLogIngestCursor)
      .values({
        source: OP_LOG_SOURCE,
        inode: batch.next.inode,
        offset: batch.next.offset,
        gapAt,
      })
      .onConflictDoUpdate({
        target: _opLogIngestCursor.source,
        set: {
          inode: batch.next.inode,
          offset: batch.next.offset,
          gapAt,
        },
      });
    return { kind: "ok", written: rows.length };
  });
}
