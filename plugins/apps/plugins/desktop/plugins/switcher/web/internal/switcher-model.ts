/**
 * The switcher's pure model: which windows it lists, in which order, and how a
 * press moves the selection. No React and no window store — the overlay hands
 * it the windows and draws the result.
 */

/** Fewer windows than this and there is nothing to switch between. */
export const MIN_SWITCHER_WINDOWS = 2;

/** The slice of a window the switcher orders by. */
export interface SwitcherWindow {
  desktopId: string;
  geo: { z: number };
}

/** The windows on `desktopId`, front-most first (`geo.z` descending). */
export function switcherOrder<W extends SwitcherWindow>(
  windows: Iterable<W>,
  desktopId: string,
): W[] {
  return [...windows]
    .filter((w) => w.desktopId === desktopId)
    .sort((a, b) => b.geo.z - a.geo.z);
}

/**
 * The selection after a press: `delta` (+1 forward, −1 back) from `index`,
 * wrapping at both ends. The opening press steps from 0 — the front-most window
 * — so forward lands on the one behind it and back on the last.
 */
export function stepIndex(index: number, delta: number, count: number): number {
  return (((index + delta) % count) + count) % count;
}
