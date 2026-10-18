import { useSyncExternalStore } from "react";
import type { WindowId } from "../hooks/use-floating-windows";

// The window being peeked at — hovered in the shelf's thumbnails — raised over
// every other window, which fade almost away (mockup `.peeking`). Written by the
// shelf (another plugin, a sibling subtree), read by every window's motion: a
// module-global channel for the same reason the snap preview is one — one
// desktop per page, writer and reader in unrelated subtrees.
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: the one desktop's peeked window, written by the shelf and read by every window's style in another subtree (mirrors the snap-preview channel).
let peeked: WindowId | null = null;
const subscribers = new Set<() => void>();

/**
 * Peek at `id` — raise it above every window and fade the rest — or end the
 * peek with `null`. A minimised window has nothing on screen to show, so
 * peeking at one only fades the others.
 */
export function setPeekedWindow(id: WindowId | null): void {
  if (peeked === id) return;
  peeked = id;
  for (const fn of subscribers) fn();
}

/** Reactive read of the peeked window (null while nothing is peeked). */
export function usePeekedWindow(): WindowId | null {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => peeked,
    () => peeked,
  );
}
