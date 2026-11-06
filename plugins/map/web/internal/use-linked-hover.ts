import { useState, useSyncExternalStore } from "react";
import { createLinkedHover, type LinkedHover } from "../../core";

/**
 * One linked hover shared by every surface that reports it (`MapView`'s
 * `onHoverChange`, a DataView's `rowHover`, a card's enter / leave), as a
 * store held for the component's lifetime. Holding it re-renders nothing:
 * each surface reads its part with `useHoveredId` / `useIsHovered`.
 */
export function useLinkedHover(): LinkedHover {
  const [hover] = useState(createLinkedHover);
  return hover;
}

const NO_SUBSCRIPTION = (): (() => void) => () => {};
const NOTHING_HOVERED = (): null => null;

/** The hovered id, re-rendering on each change (`null` with no hover given). */
export function useHoveredId(
  hover: LinkedHover | null | undefined,
): string | null {
  return useSyncExternalStore(
    hover?.subscribe ?? NO_SUBSCRIPTION,
    hover?.get ?? NOTHING_HOVERED,
  );
}

/**
 * Whether `id` is the hovered id — re-rendering only when that answer flips,
 * so a pointer crossing a list re-renders the two rows it left and entered.
 */
export function useIsHovered(
  hover: LinkedHover | null | undefined,
  id: string,
): boolean {
  return useSyncExternalStore(hover?.subscribe ?? NO_SUBSCRIPTION, () =>
    hover === null || hover === undefined ? false : hover.get() === id,
  );
}
