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
 * What WebKit answers an IndexedDB open with when the open needs an upgrade
 * (always so when it creates the database) and the reply arrives while the
 * requesting context is suspended — its page in the back/forward cache:
 * WebKit aborts the upgrade rather than let a frozen page block every other
 * connection, and fails the open with an `UnknownError` carrying this text
 * (`IDBConnectionProxy::completeOpenDBRequest`, WebCore). The context sees it
 * once it runs again. The upgrade never ran, so nothing was written by it.
 */
const SUSPENDED_UPGRADE_ABORT =
  "Version change transaction on cached page is aborted";

/**
 * Whether `err` (or an error in its `cause` chain) is WebKit's abort of an
 * IndexedDB upgrade answered while this context was suspended — whichever
 * open it was: the stores' (`idb.ts`) or PGlite's own filesystem's, which
 * hands the request's error up unchanged.
 */
export function isSuspendedUpgradeAbort(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e != null && depth < 8; depth++) {
    if (
      typeof e === "object" &&
      "message" in e &&
      typeof e.message === "string" &&
      e.message.includes(SUSPENDED_UPGRADE_ABORT)
    ) {
      return true;
    }
    e = typeof e === "object" && "cause" in e ? e.cause : null;
  }
  return false;
}

/**
 * The boot was cut short by the browser suspending the page
 * (`isSuspendedUpgradeAbort`), not by a fault: the host declines
 * (`{ kind: "interrupted" }`) and the page starts it again on a fresh worker.
 * The storage it began is left as a fresh boot would find it — a database
 * never created, or a lifecycle record still `seeding`, which the next open
 * wipes and seeds again.
 */
export class BootInterruptedError extends HostRefusedError {
  constructor(cause: unknown) {
    super(
      { kind: "interrupted" },
      "the browser aborted an IndexedDB upgrade while the page was suspended (back/forward cache)",
    );
    this.name = "BootInterruptedError";
    this.cause = cause;
  }
}
