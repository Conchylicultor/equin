import type { Geometry } from "../hooks/use-floating-windows";
import { snapRect, type SnapZone } from "../hooks/use-snap";

/** A normalized rect inside the desktop, every field a fraction in `0..1`. */
export interface RectFraction {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * The fractional box of a snap zone — `snapBox` re-expressed as plain `0..1`
 * fractions, deliberately IGNORING the {@link SNAP_GAP} gutter and the shelf reserve. At minimap
 * scale the 6px gutter is sub-pixel noise, and dropping it yields clean
 * halves/quarters (a left tile reads as exactly the left half) — far more
 * legible than a hairline-inset tile. Mirrors `snapBox`'s zone → box mapping so
 * the preview always matches where the real window actually snaps.
 */
export function snapFraction(zone: SnapZone): RectFraction {
  switch (zone) {
    case "maximize":
      return { left: 0, top: 0, width: 1, height: 1 };
    case "left":
      return { left: 0, top: 0, width: 0.5, height: 1 };
    case "right":
      return { left: 0.5, top: 0, width: 0.5, height: 1 };
    case "top":
      return { left: 0, top: 0, width: 1, height: 0.5 };
    case "bottom":
      return { left: 0, top: 0.5, width: 1, height: 0.5 };
    case "top-left":
      return { left: 0, top: 0, width: 0.5, height: 0.5 };
    case "top-right":
      return { left: 0.5, top: 0, width: 0.5, height: 0.5 };
    case "bottom-left":
      return { left: 0, top: 0.5, width: 0.5, height: 0.5 };
    case "bottom-right":
      return { left: 0.5, top: 0.5, width: 0.5, height: 0.5 };
  }
}

/**
 * A window's box as `0..1` fractions of the desktop, ready to drop straight
 * onto a minimap rect's `left/top/width/height`. With the desktop measured
 * (`dw` × `dh`), a snapped window resolves through `snapRect` — the same tile
 * the real window takes, inside the work area that leaves `reserve` px for the
 * shelf; unmeasured, through {@link snapFraction} (resolution-independent). A
 * free-floating window divides its pixel box by the desktop size, clamped to
 * the frame so a window hanging off an edge never paints outside the minimap.
 * Returns `null` when free-floating and the desktop has not been measured yet
 * (`dw`/`dh` still `0`), so the caller can skip drawing a mis-scaled rect.
 */
export function windowRectFraction(
  geo: Geometry,
  dw: number,
  dh: number,
  reserve = 0,
): RectFraction | null {
  if (geo.snap) {
    if (!dw || !dh) return snapFraction(geo.snap);
    const r = snapRect(geo.snap, dw, dh, reserve);
    return { left: r.x / dw, top: r.y / dh, width: r.w / dw, height: r.h / dh };
  }
  if (!dw || !dh) return null;
  return {
    left: clamp01(geo.x / dw),
    top: clamp01(geo.y / dh),
    width: clamp01(geo.w / dw),
    height: clamp01(geo.h / dh),
  };
}
