import { useSyncExternalStore } from "react";

// The desktop's work area — the backdrop minus the strip the shelf keeps for
// itself at the bottom. Maximise, snap tiles and the overview lay out inside
// it, so a maximised window never slides under the dock. Written by the shelf
// (a different plugin, a sibling subtree of the windows), read by the windows'
// geometry: a module-global channel for the same reason the snap preview is
// one — one desktop per page, writer and reader in unrelated subtrees.
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: the one desktop's bottom reserve, written by the shelf and read by the window geometry in another subtree (mirrors the snap-preview channel).
let reserveBottom = 0;
const subscribers = new Set<() => void>();

/**
 * Reserve `px` at the bottom of the desktop for the shelf (0 to release).
 * Returns the disposer that releases it, so an effect's cleanup is the
 * disposer itself.
 */
export function setWorkAreaReserve(px: number): () => void {
  if (reserveBottom !== px) {
    reserveBottom = px;
    for (const fn of subscribers) fn();
  }
  return () => {
    if (reserveBottom === px) setWorkAreaReserve(0);
  };
}

/** One-shot read of the bottom reserve (px) — event handlers only. */
export function getWorkAreaReserve(): number {
  return reserveBottom;
}

/** Reactive read of the bottom reserve (px). */
export function useWorkAreaReserve(): number {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => reserveBottom,
    () => reserveBottom,
  );
}
