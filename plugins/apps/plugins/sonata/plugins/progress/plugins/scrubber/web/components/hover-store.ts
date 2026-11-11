import { useSyncExternalStore } from "react";

/** Where the pointer is over the track: the (possibly snapped) beat and its
 *  [0,1] position. `null` = not hovering. */
export type HoverPoint = { beat: number; fraction: number };

/**
 * A one-value store the scrubber's pointer handlers write and only the preview
 * reads — so a pointer move re-renders the small preview box, never the bar
 * (its rail, markers and labels stay put).
 */
export type HoverStore = {
  get: () => HoverPoint | null;
  set: (p: HoverPoint | null) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createHoverStore(): HoverStore {
  let value: HoverPoint | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (p) => {
      value = p;
      for (const l of listeners) l();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

/**
 * Where the pointer is now, re-rendering on every move. A static render reads
 * the store as it stands: nothing is hovered there.
 */
export function useHoverPoint(store: HoverStore): HoverPoint | null {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
