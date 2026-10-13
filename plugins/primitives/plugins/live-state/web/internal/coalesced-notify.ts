import { defaultScheduler, notifyManager } from "@tanstack/react-query";

/**
 * React Query's notification scheduler, coalesced: every observer
 * notification scheduled before the next flush runs in that ONE task.
 *
 * Each cache write (`setQueryData` — one per WS frame the client applies)
 * is its own `notifyManager.batch`, and the default scheduler gives each
 * batch's flush its own `setTimeout(0)` task. React renders the
 * `useSyncExternalStore` updates of one task in one commit, so N frames
 * landing back to back — a cold page's burst of sub-acks, one per row of a
 * list — cost N commits, each re-rendering one reader. Coalesced, the flushes
 * queued behind one timer run in one task: the burst is one commit, and a
 * burst arriving while a commit runs joins the next one, so the commit rate
 * follows how fast React drains them, not how many frames there were.
 *
 * Nothing else moves: notifications stay asynchronous, in the order they
 * were scheduled, through the same timer. A callback that throws does not
 * cancel the rest of the flush; its error is rethrown in its own microtask,
 * so it still surfaces as an uncaught error.
 */
let queued: (() => void)[] | null = null;

function runQueued(): void {
  const run = queued ?? [];
  // Reset BEFORE running: a notification scheduled by a callback (or by the
  // render it triggers) opens the next flush instead of growing this one.
  queued = null;
  for (const callback of run) {
    try {
      callback();
    } catch (err) {
      queueMicrotask(() => {
        throw err;
      });
    }
  }
}

export function coalescedScheduler(callback: () => void): void {
  if (queued !== null) {
    queued.push(callback);
    return;
  }
  queued = [callback];
  defaultScheduler(runQueued);
}

/** Install `coalescedScheduler` on React Query's (page-global) notify manager. */
export function installCoalescedNotify(): void {
  notifyManager.setScheduler(coalescedScheduler);
}
