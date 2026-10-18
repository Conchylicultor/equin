import { useSyncExternalStore, type CSSProperties } from "react";

/**
 * A snap target: the full desktop, a half, or a quarter. `maximize` is the full
 * screen (the unified replacement for the old `maximized` boolean); the rest are
 * Aero-style edge/corner tiles.
 */
export type SnapZone =
  | "maximize"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/** Gutter (px) between a snapped tile and the work-area edges / centerlines (mockup `GAP`). */
export const SNAP_GAP = 6;

/** A pixel box in desktop (backdrop) coordinates. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The absolute CSS box for a snap zone, expressed purely in `left/top/width/height`
 * (percentages + calc, never `right`/`bottom`/`auto`) so it is both
 * resolution-independent (reflows on desktop resize) AND smoothly *transitionable*:
 * every snap, maximize, and restore is a change of the SAME four numeric
 * properties, so the placement container can `transition` between a free pixel box
 * and a snapped percentage box (an `auto` inset would break the interpolation).
 *
 * Every box lies inside the WORK AREA — the backdrop minus the `reserve` px the
 * shelf keeps at the bottom (`useWorkAreaReserve`), so a tile never slides under
 * the dock. `maximize` fills the work area edge to edge; halves/quarters keep a
 * {@link SNAP_GAP} gutter from its edges and shared centerlines. The CSS twin of
 * {@link snapRect} (the mockup's `snapRect`), which the snap ghost, the overview
 * and "tile all" read in pixels.
 */
export function snapBox(zone: SnapZone, reserve = 0): CSSProperties {
  const workH = `(100% - ${reserve}px)`;
  if (zone === "maximize")
    return { left: 0, top: 0, width: "100%", height: `calc${workH}` };
  const g = SNAP_GAP;
  // Half the work area minus three gutters (outer, centre, outer) split in two.
  const halfW = `calc((100% - ${g * 3}px) / 2)`;
  const halfH = `calc((${workH} - ${g * 3}px) / 2)`;
  // Origin of the far (right/bottom) tile: one gutter past the near tile.
  const farX = `calc(${g * 2}px + (100% - ${g * 3}px) / 2)`;
  const farY = `calc(${g * 2}px + (${workH} - ${g * 3}px) / 2)`;
  // A full span minus both outer gutters.
  const fullW = `calc(100% - ${g * 2}px)`;
  const fullH = `calc(${workH} - ${g * 2}px)`;
  switch (zone) {
    case "left":
      return { left: g, top: g, width: halfW, height: fullH };
    case "right":
      return { left: farX, top: g, width: halfW, height: fullH };
    case "top":
      return { left: g, top: g, width: fullW, height: halfH };
    case "bottom":
      return { left: g, top: farY, width: fullW, height: halfH };
    case "top-left":
      return { left: g, top: g, width: halfW, height: halfH };
    case "top-right":
      return { left: farX, top: g, width: halfW, height: halfH };
    case "bottom-left":
      return { left: g, top: farY, width: halfW, height: halfH };
    case "bottom-right":
      return { left: farX, top: farY, width: halfW, height: halfH };
  }
}

/**
 * {@link snapBox} in pixels, for a measured desktop of `width` × `height` with
 * `reserve` px kept at the bottom — the mockup's `snapRect` verbatim.
 */
export function snapRect(
  zone: SnapZone,
  width: number,
  height: number,
  reserve = 0,
): Rect {
  const g = SNAP_GAP;
  const h = workAreaHeight(height, reserve);
  if (zone === "maximize") return { x: 0, y: 0, w: width, h };
  const hw = (width - g * 3) / 2;
  const hh = (h - g * 3) / 2;
  const farX = g * 2 + hw;
  const farY = g * 2 + hh;
  switch (zone) {
    case "left":
      return { x: g, y: g, w: hw, h: h - g * 2 };
    case "right":
      return { x: farX, y: g, w: hw, h: h - g * 2 };
    case "top":
      return { x: g, y: g, w: width - g * 2, h: hh };
    case "bottom":
      return { x: g, y: farY, w: width - g * 2, h: hh };
    case "top-left":
      return { x: g, y: g, w: hw, h: hh };
    case "top-right":
      return { x: farX, y: g, w: hw, h: hh };
    case "bottom-left":
      return { x: g, y: farY, w: hw, h: hh };
    case "bottom-right":
      return { x: farX, y: farY, w: hw, h: hh };
  }
}

/** The work area's height: the desktop minus the shelf's reserve, never under 200px (mockup `work()`). */
export function workAreaHeight(height: number, reserve: number): number {
  return Math.max(200, height - reserve);
}

/** A keyboard tiling nudge along one axis (the four arrow directions). */
export type SnapDirection = "left" | "right" | "up" | "down";

/**
 * The outcome of a directional keyboard snap: re-tile to a zone (`zone: null`
 * restores the free floating box) or minimize the window to the dock.
 */
export type SnapAction =
  | { type: "snap"; zone: SnapZone | null }
  | { type: "minimize" };

const toSnap = (zone: SnapZone | null): SnapAction => ({ type: "snap", zone });
const MINIMIZE: SnapAction = { type: "minimize" };

/**
 * Windows-Aero-style directional tiling state machine for keyboard snapping.
 *
 * A left/right half is the middle rung of its vertical axis: Up/Down tile it to
 * the matching quarter and back, while Left/Right toggle the half off (restore
 * to free) or flip a quarter across to the other side. Maximize caps the
 * vertical chain — Up maximizes from free, Down restores to free and then
 * minimizes. Only the zones reachable by mouse drag are produced (no standalone
 * top/bottom halves), so keyboard tiling and pointer tiling stay consistent.
 */
export function nextSnapAction(
  current: SnapZone | null,
  dir: SnapDirection,
): SnapAction {
  switch (dir) {
    case "left":
      return snapLeft(current);
    case "right":
      return snapRight(current);
    case "up":
      return snapUp(current);
    case "down":
      return snapDown(current);
  }
}

function snapLeft(current: SnapZone | null): SnapAction {
  switch (current) {
    case null:
    case "maximize":
      return toSnap("left");
    case "right":
      return toSnap(null);
    case "top":
    case "top-right":
      return toSnap("top-left");
    case "bottom":
    case "bottom-right":
      return toSnap("bottom-left");
    case "left":
    case "top-left":
    case "bottom-left": // already as far left as it goes
      return toSnap(current);
  }
}

function snapRight(current: SnapZone | null): SnapAction {
  switch (current) {
    case null:
    case "maximize":
      return toSnap("right");
    case "left":
      return toSnap(null);
    case "top":
    case "top-left":
      return toSnap("top-right");
    case "bottom":
    case "bottom-left":
      return toSnap("bottom-right");
    case "right":
    case "top-right":
    case "bottom-right":
      return toSnap(current);
  }
}

function snapUp(current: SnapZone | null): SnapAction {
  switch (current) {
    case null:
      return toSnap("maximize");
    case "left":
      return toSnap("top-left");
    case "right":
      return toSnap("top-right");
    case "bottom-left":
      return toSnap("left");
    case "bottom-right":
      return toSnap("right");
    case "bottom":
      return toSnap(null);
    case "maximize":
    case "top":
    case "top-left":
    case "top-right":
      return toSnap(current);
  }
}

function snapDown(current: SnapZone | null): SnapAction {
  switch (current) {
    case null:
      return MINIMIZE;
    case "maximize":
    case "top":
      return toSnap(null);
    case "left":
      return toSnap("bottom-left");
    case "right":
      return toSnap("bottom-right");
    case "top-left":
      return toSnap("left");
    case "top-right":
      return toSnap("right");
    case "bottom":
    case "bottom-left":
    case "bottom-right":
      return MINIMIZE;
  }
}

/** Distance (px) from a side edge that arms a half / quarter snap (mockup `EDGE`). */
const EDGE = 10;
/** Distance (px) from the top edge that arms maximize. */
const TOP_EDGE = 2;

/**
 * Resolve which snap zone a titlebar drag is hovering, given the pointer in
 * backdrop-relative coords, the backdrop width and the WORK-AREA height (the
 * backdrop minus the shelf's reserve) — the mockup's `detectSnap` verbatim. A
 * side edge ({@link EDGE}) snaps a half, or a quarter within the corner band
 * (`min(120, 20%` of the height`)`) of the top / bottom; the very top
 * ({@link TOP_EDGE}) maximizes. The bottom edge alone does not snap (the shelf
 * lives there). The pointer past a side edge still counts as that edge.
 */
export function detectSnapZone(
  px: number,
  py: number,
  width: number,
  height: number,
): SnapZone | null {
  const corner = Math.min(120, height * 0.2);
  if (px <= EDGE)
    return py < corner
      ? "top-left"
      : py > height - corner
        ? "bottom-left"
        : "left";
  if (px >= width - EDGE)
    return py < corner
      ? "top-right"
      : py > height - corner
        ? "bottom-right"
        : "right";
  if (py <= TOP_EDGE) return "maximize";
  return null;
}

// Transient snap-preview channel: the dragging window's titlebar writes the
// hovered zone here on every pointermove; the desktop-level <SnapPreviewOverlay>
// (a Foreground sibling of the windows, a different React subtree) reads it. A
// module-global is the right shared channel here for the exact reason the
// window store is one — writer and reader live in unrelated subtrees under the
// generic surface host, with only ever one drag in flight. The last armed zone
// is kept while hidden, so the ghost fades out where it was (mockup `#snap-ghost`).
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: a transient drag-preview channel shared between the dragging window's chrome and the desktop-level overlay (separate subtrees), mirroring the module-global geometry store in this plugin.
let snapPreview: { zone: SnapZone | null; shown: boolean } = {
  zone: null,
  shown: false,
};
const subscribers = new Set<() => void>();

/** Set (or clear, with null) the live snap-preview zone. No-op when unchanged. */
export function setSnapPreview(zone: SnapZone | null) {
  const next = zone
    ? { zone, shown: true }
    : { zone: snapPreview.zone, shown: false };
  if (next.zone === snapPreview.zone && next.shown === snapPreview.shown)
    return;
  snapPreview = next;
  for (const fn of subscribers) fn();
}

/**
 * Reactive read of the snap preview: the zone last armed (kept after the
 * pointer leaves it, so the ghost can fade out in place) and whether it is
 * armed now.
 */
export function useSnapPreview(): { zone: SnapZone | null; shown: boolean } {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => snapPreview,
    () => snapPreview,
  );
}
