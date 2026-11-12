import { z } from "zod";

/**
 * The report kind string, spelled once: the server registers its `ReportKind`
 * under it and the shared record store (`plugin-records/cli`) files under it.
 */
export const RECORDS_WRITE_LOST_KIND = "plugin-records-write-lost";

/** Why a write was lost. Closed: a new cause is a new arm, named here. */
export const RecordsWriteLostReasonSchema = z.enum([
  // The store's write lock stayed taken past the backstop busy wait — by a
  // writer outside the store's writer line (every writer of this file version
  // queues in it, so one outside it is not this code).
  "busy",
  // Any other SQLite failure of the write: the disk full, an I/O error.
  "sqlite",
  // A ticket in the writer line could not be taken or left (its directory,
  // or the child a waiter blocks in).
  "line",
  // No turn in the writer line within its bound: whoever was ahead stalled
  // holding its ticket (a stopped or starved process).
  "line-timeout",
]);
export type RecordsWriteLostReason = z.infer<
  typeof RecordsWriteLostReasonSchema
>;

/**
 * One lost write: which process lost how many records, and how its writes
 * waited and held the lock until then — the line's own measurements, so the
 * report says whether this process waited in the line or behind something
 * outside it.
 */
export const RecordsWriteLostPayloadSchema = z.object({
  reason: RecordsWriteLostReasonSchema,
  /** The store's file. */
  store: z.string(),
  /** How many records the lost write held. */
  records: z.number().int(),
  /** The SQLite error, as thrown. */
  error: z.string(),
  pid: z.number().int(),
  /** The process's command line, abridged — which build / check / script lost them. */
  command: z.string(),
  /** Write transactions this write committed before it was lost. */
  transactions: z.number().int(),
  /** Time spent waiting in the writer line, in total and the longest once. */
  waitedMs: z.number(),
  longestWaitMs: z.number(),
  /** Time the write lock was held, in total and the longest once. */
  heldMs: z.number(),
  longestHoldMs: z.number(),
});
export type RecordsWriteLostPayload = z.infer<
  typeof RecordsWriteLostPayloadSchema
>;

/** One row per cause: each lost write bumps its count. */
export function recordsWriteLostFingerprint(
  d: RecordsWriteLostPayload,
): string {
  return `${RECORDS_WRITE_LOST_KIND}:${d.reason}`;
}

/** The one-line summary — the report row's `message` and the store's log line. */
export function recordsWriteLostMessage(d: RecordsWriteLostPayload): string {
  return (
    `plugin records not written: ${d.records} records lost (${d.reason}: ${d.error}) ` +
    `after ${d.transactions} transactions, ${Math.round(d.waitedMs)} ms in the writer line ` +
    `(longest ${Math.round(d.longestWaitMs)} ms) — they are computed again next time`
  );
}
