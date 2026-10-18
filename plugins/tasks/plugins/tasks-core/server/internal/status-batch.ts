import { db } from "@plugins/database/server";
import type { TaskStatus } from "./schema";
import { flushStatusBatch } from "./status-emit";

// db-or-tx executor, same shape as RankExecutor
// (plugins/primitives/plugins/rank/server/internal/helpers.ts).
export type DbExecutor =
  typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface StatusBatch {
  tx: DbExecutor; // the open transaction handle
  before: Map<string, TaskStatus | null>; // earliest entry-status per task
}

// The open batch of each executor, keyed by the transaction handle itself — the
// `exec` every `withTaskStatusChange` already receives — so a write finds its
// batch on the connection it writes on, with no ambient context. (The batch used
// to ride an AsyncLocalStorage, a Node-only primitive this portable module may
// not import; see `withTaskStatusChange` for the one assertion that went with it.)
const batches = new WeakMap<DbExecutor, StatusBatch>();

/** The status batch open on `exec`, if any. */
export const statusBatchOn = (exec: DbExecutor): StatusBatch | undefined =>
  batches.get(exec);

// Join an EXISTING transaction as a status batch: every `withTaskStatusChange`
// inside records its closure's entry statuses and suppresses its own emit, and
// the net before→after is flushed on `tx` when `fn` returns.
//
// Split out from `withTaskStatusBatch` so a caller that already owns a
// transaction gets a REAL batch on its own connection rather than a second,
// nested one — which is also what lets a test drive a batch inside the
// transaction it will deliberately roll back.
//
// `tx` must be a transaction handle, never `db` itself: a batch keyed on the
// pool would capture every concurrent request's writes.
export async function runStatusBatchOn<T>(
  tx: DbExecutor,
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  if (tx === db) {
    throw new Error(
      "[tasks-core] runStatusBatchOn: a status batch joins a TRANSACTION — pass its `tx`, not `db` (or use withTaskStatusBatch, which opens one).",
    );
  }
  if (batches.has(tx)) {
    throw new Error(
      "[tasks-core] runStatusBatchOn: a status batch is already open on this transaction.",
    );
  }
  const batch: StatusBatch = { tx, before: new Map() };
  batches.set(tx, batch);
  let result: T;
  try {
    result = await fn(tx);
  } finally {
    batches.delete(tx);
  }
  await flushStatusBatch(batch); // reads net status on tx, emits with { tx }
  return result;
}

// Run `fn` in ONE transaction with tasks.statusChanged emits coalesced to the
// NET before→after of the whole operation. Every `withTaskStatusChange` inside
// records its affected tasks' entry statuses but SUPPRESSES its own emit; on
// commit, one trigger is emitted per task whose net status actually differs —
// enqueued on the tx so it lives or dies with the edge writes.
export async function withTaskStatusBatch<T>(
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  return db.transaction((tx) => runStatusBatchOn(tx, fn));
}
