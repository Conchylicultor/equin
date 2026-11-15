import type { EmitTx } from "../internal/event";
import { definedTriggerTables } from "../internal/registry";

/**
 * Delete, on `tx`, every stored trigger row of every event this process has
 * defined — so an emit on `tx` matches no subscriber.
 *
 * For a test driving a REAL database (a worktree's, forked from main) inside a
 * transaction it rolls back: that database holds the subscriptions a booted
 * backend stored (declared `Trigger` contributions, runtime `trigger()` rows),
 * each naming a job the bare test process never registered — and delivering to
 * one throws ("emitted before any job was registered"), as it must in a real
 * backend. Which rows exist depends on how the database was last booted, not
 * on the suite, so a suite must not see them. A subscription the test body
 * itself stores afterwards is untouched.
 *
 * Only ever on a transaction that is rolled back: on a committed handle this
 * deletes real subscriptions.
 */
export async function detachStoredTriggers(tx: EmitTx): Promise<void> {
  for (const table of definedTriggerTables) await tx.delete(table);
}
