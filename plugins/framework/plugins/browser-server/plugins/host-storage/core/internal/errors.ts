import { HostRefusedError } from "@plugins/framework/plugins/browser-server/core";

/**
 * The storage belongs to newer code than this worker's: its stored data was
 * migrated (or seeded) by a newer build, or a newer build's worker holds it.
 * Booting would run old code over the new schema, so the host refuses
 * (`{ kind: "outdated" }`), and the tab asks for a reload — which loads the
 * newer build.
 */
export class StorageNewerThanCodeError extends HostRefusedError {
  constructor(detail: string) {
    super({ kind: "outdated" }, detail);
    this.name = "StorageNewerThanCodeError";
  }
}

/**
 * What WebKit raises in a context whose IndexedDB work it cut short because
 * the context's process or page was SUSPENDED (a page in the back/forward
 * cache, a background tab's process) while that work stood in the way of
 * another context on the same database (another tab, its worker). WebCore
 * spells each case with its own text, all `UnknownError`:
 * - an open whose upgrade (always so when it creates the database) is
 *   answered while the context is suspended: the upgrade is aborted
 *   (`IDBConnectionProxy::completeOpenDBRequest`, report-1795070221-uzvq63);
 * - a connection a versionchange event reaches while the context is
 *   suspended: closed on its behalf (`IDBConnectionProxy::fireVersionChangeEvent`);
 * - a transaction in progress that blocks another client's while its client
 *   is suspended: aborted on the server
 *   (`UniqueIDBDatabase::abortInProgressTransactionsOfSuspendedClientsIfNeeded`).
 *   The client learns it only once it runs again: its commit fails with
 *   "Transaction was aborted while its process was suspended", and each
 *   request it still had queued reaches a server transaction that is gone —
 *   "Attempt to <op> without an in-progress transaction"
 *   (`SQLiteIDBBackingStore`; PGlite's IDBFS sync deleting a removed file,
 *   report-1795189021-x5spzw).
 * What was cut short never committed (an IndexedDB transaction is atomic),
 * so the data is as it stood before it.
 */
const SUSPENSION_ABORTS: ReadonlyArray<(message: string) => boolean> = [
  (m) =>
    m.includes(
      "Version change transaction on cached page is aborted to unblock other connections",
    ),
  (m) =>
    m.includes("Connection on cached page closed to unblock other connections"),
  (m) => m.includes("Transaction was aborted while its process was suspended"),
  (m) => /^Attempt to .+ without an in-progress transaction$/.test(m),
];

/**
 * Whether `err` (or an error in its `cause` chain) is WebKit cutting this
 * context's IndexedDB work short because it was suspended — whichever
 * database it was: the stores' (`idb.ts`) or PGlite's own filesystem's,
 * which hands the request's error up unchanged.
 */
export function isSuspensionAbort(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e != null && depth < 8; depth++) {
    const message =
      typeof e === "object" && "message" in e && typeof e.message === "string"
        ? e.message
        : null;
    if (
      message !== null &&
      SUSPENSION_ABORTS.some((matches) => matches(message))
    ) {
      return true;
    }
    e = typeof e === "object" && "cause" in e ? e.cause : null;
  }
  return false;
}

/**
 * The boot was cut short by the browser suspending the page
 * (`isSuspensionAbort`), not by a fault: the host declines
 * (`{ kind: "interrupted" }`) and the page starts it again on a fresh worker.
 * The storage is left as its last committed transaction left it — a
 * database never created, a lifecycle record still `seeding` (which the next
 * open wipes and seeds again), or a booted one short of the write that was
 * cut, as after a tab closed mid-write.
 */
export class BootInterruptedError extends HostRefusedError {
  constructor(cause: unknown) {
    super(
      { kind: "interrupted" },
      "the browser cut the storage's IndexedDB work short while the page was suspended (back/forward cache, a background tab)",
    );
    this.name = "BootInterruptedError";
    this.cause = cause;
  }
}
