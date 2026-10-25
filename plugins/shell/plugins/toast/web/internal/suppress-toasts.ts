import { useEffect, useSyncExternalStore } from "react";

/**
 * Surfaces that turned the page's toasts off (a mount set, like the ledger in
 * `live-toasts.ts`: a Set of mount tokens, so StrictMode's track → untrack →
 * track settles right). While any is mounted, the host draws no toasts.
 */
const holders = new Set<symbol>();
const listeners = new Set<() => void>();

// eslint-disable-next-line scoped-store/no-module-mutable-store -- the toast stack IS page-global: one <ToasterHost/> at Core.Root. A surface that turns it off turns it off for its document.
let suppressed = false;

function publish(): void {
  suppressed = holders.size > 0;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The calling surface shows no toasts: while it is mounted the page's toast
 * host draws nothing — for a document that is one small surface (the
 * menu-bar panel), where the app-wide stack does not belong. `showToast` from
 * inside it then lands nowhere, so the surface must say its outcomes inline.
 */
export function useSuppressToasts(): void {
  useEffect(() => {
    const token = Symbol("suppress-toasts");
    holders.add(token);
    publish();
    return () => {
      holders.delete(token);
      publish();
    };
  }, []);
}

/** Whether a mounted surface has turned the page's toasts off. */
export function useToastsSuppressed(): boolean {
  return useSyncExternalStore(subscribe, () => suppressed);
}
