import { symbol } from "./icon-ref";

/**
 * The icon a navigating control wears, named by WHERE it sends you — so two
 * controls that open the same kind of destination cannot draw different
 * glyphs, and one glyph never means two destinations.
 *
 * - `newTab` — a new BROWSER tab, leaving this one as it is: an app page, an
 *   external site, another worktree's origin. Only ever drawn by the
 *   `link-gesture/new-tab` primitive, which owns the behaviour with it
 *   (`new-tab/no-adhoc-new-tab`), so the arrow cannot be paired with anything
 *   else. (Arrow out of a box.)
 * - `newAppTab` — a new tab of THIS app's own tab bar (`navigate(url,
 *   { newTab: true })`). A different glyph on purpose: "new tab" with no
 *   qualifier means a browser tab, and the two must never look alike.
 * - `hostApp` — out of the browser into the machine: a host file opened with
 *   its default app. (A monitor.)
 * - `sidePane` — beside what you are reading, in this surface: a pane pushed to
 *   the right. (A panel opening on the right.)
 * - `expand` — this destination takes over the surface: the pane promoted to
 *   the root, or the thing opened in its home app ("Open in Pages"). (Diagonal
 *   arrows outward.)
 *
 * Fullscreen (`symbol("fullscreen")`) is a different, window-level idea — solo
 * mode, the browser's fullscreen, presenting — and is not a destination.
 *
 * The glyphs are reserved: `icons/reserved-nav-icon` rejects spelling
 * them with `symbol(…)` anywhere but here.
 */
export const navIcons = {
  newTab: symbol("open-in-new"),
  newAppTab: symbol("tab-new-right"),
  hostApp: symbol("desktop-windows"),
  sidePane: symbol("right-panel-open"),
  expand: symbol("open-in-full"),
} as const;
