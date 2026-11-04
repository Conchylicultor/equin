import { serveValue } from "@plugins/network/plugins/live/server";
import { dbLockWatch, type LockWatchObservation } from "../../core";

let latest: LockWatchObservation | null = null;

// External: the truth is the watch's latest look, held in this process (the
// watch job runs in this backend, `perWorktree`), which no change-feed can see.
export const dbLockWatchServed = serveValue(dbLockWatch, {
  source: "external",
  changes: "notified",
  loader: () => ({ observation: latest }),
});

/** Publish a look: every look, since `observedAt` is part of what a reader shows ("as of 10:21"). */
export function publishObservation(o: LockWatchObservation): void {
  latest = o;
  dbLockWatchServed.notify();
}
