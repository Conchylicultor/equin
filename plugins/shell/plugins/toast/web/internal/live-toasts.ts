import { useSyncExternalStore } from "react";

/**
 * The plugin's ledger of the toasts it currently has on screen.
 *
 * It is not a copy of sonner's toast list, and deliberately so — the two
 * previous versions of this affordance each kept one (`useSonner()`, then a
 * ledger written at enqueue time and retired from sonner's exit callbacks) and
 * each drifted, because a parallel copy of "what is on screen" has its own
 * update path and no way back once that path is missed.
 *
 * Instead the ledger *is* the mount set: `ToastBody` renders inside every toast
 * we fire and calls `trackToast` on mount, `untrackToast` on unmount, so React
 * maintains it for us. Two consequences follow for free: every exit a toast has
 * (its timer, the close button, a swipe, the action button, a programmatic
 * `dismiss`, the host unmounting) converges on that one unmount, so no exit
 * needs enumerating; and an enqueue sonner drops never mounts, so it is never
 * counted. Nothing here is state that isn't derived from something on screen.
 *
 * Scope of "on screen", both intentional:
 * - A dismissed toast stays counted for its ~200ms exit animation
 *   (`TIME_BEFORE_UNMOUNT`, sonner 2.0.7 `dist/index.mjs:425`). The count is
 *   therefore exactly "toasts currently painted", and the button fades out
 *   with the stack rather than ahead of it.
 * - Toasts queued past `visibleToasts` count: sonner mounts all of them and
 *   `visibleToasts` only drives opacity — and sweeping precisely those is the
 *   "Dismiss all" button's whole justification.
 */
const liveIds = new Set<string>();
const listeners = new Set<() => void>();

/**
 * Snapshot must be a stable primitive: `useSyncExternalStore` compares by identity.
 */
// eslint-disable-next-line scoped-store/no-module-mutable-store -- the toast stack IS page-global: one <ToasterHost/> at Core.Root, one corner, and showToast() is a module-level imperative API callable from anywhere. Per-surface state would count a window's toasts against another window's stack.
let count = 0;

function publish(): void {
  count = liveIds.size;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): number {
  return count;
}

/**
 * A Set keyed by id, never a counter: StrictMode double-invokes every mount
 * effect as track → untrack → track, which a counter would settle at 2.
 */
export function trackToast(id: string): void {
  if (liveIds.has(id)) return;
  liveIds.add(id);
  publish();
}

export function untrackToast(id: string): void {
  if (liveIds.delete(id)) publish();
}

/** Number of toasts currently painted, as this plugin put them there. */
export function useLiveToastCount(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
