import { useSyncExternalStore } from "react";

// A request to open the agent manager's Claude account menu, from outside the
// agent manager (the health report's Manage accounts). Only the request is
// page-wide: the menu's open state is each sidebar foot's own, and the foot of
// the focused surface is the one that answers it.

// eslint-disable-next-line scoped-store/no-module-mutable-store -- a request from page-global chrome (the health report) to whichever agent manager surface the navigation lands in: no surface owns it until one takes it, and only the focused surface's foot does (`useAccountMenuRequested`), so it does not bleed between windows.
let requested = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (requested === next) return;
  requested = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Ask the agent manager's account menu to open (after navigating to it). */
export function requestAccountMenu(): void {
  set(true);
}

/** The menu answered the request (it opened, then closed). */
export function settleAccountMenuRequest(): void {
  set(false);
}

/** Whether a request to open the account menu is pending. */
export function useAccountMenuRequested(): boolean {
  return useSyncExternalStore(subscribe, () => requested);
}
