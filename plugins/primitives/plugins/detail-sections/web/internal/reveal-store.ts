import { useSyncExternalStore } from "react";

/** A request to open a section and scroll it into view, and when it was made. */
export interface RevealRequest {
  sectionId: string;
  at: number;
}

/**
 * The one pending reveal for a pane's sections — module state of the pane's
 * factory, because the link asking for it and the card answering it live in
 * different subtrees (often different panes), and the card may not exist yet.
 * A store with subscribers, never a poll.
 */
export interface RevealStore {
  set: (next: RevealRequest | null) => void;
  subscribe: (listener: () => void) => () => void;
  read: () => RevealRequest | null;
}

export function createRevealStore(): RevealStore {
  let reveal: RevealRequest | null = null;
  const listeners = new Set<() => void>();
  return {
    set(next) {
      reveal = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read: () => reveal,
  };
}

/**
 * The pending reveal, re-rendering on change. A static render reads the store
 * as it stands: a reveal requested before it is still pending there.
 */
export function usePendingReveal(store: RevealStore): RevealRequest | null {
  return useSyncExternalStore(store.subscribe, store.read, store.read);
}
