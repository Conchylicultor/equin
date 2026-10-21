import {
  SIZE_PRESETS,
  presetSize,
  type PresetName,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import type { CanvasSize, CanvasZoom } from "./canvas-model";

/**
 * How big every frame is, and at what scale — from three independent settings:
 *
 * - size: the frame's logical size — a device preset, a custom width, This
 *   window (the size a page gets in the viewer's own browser window), or
 *   Responsive (the frame IS the space the canvas has, measured in page pixels
 *   at this zoom);
 * - zoom: Fit (the whole frame visible at once) or a fixed scale;
 * - whole page: show each page's entire content instead of one screen of it.
 *
 * Pure. The canvas measures the room one frame has and the pages' heights; this
 * turns them into numbers.
 */

/**
 * The room the canvas's floating chrome leaves the frames, in px (inline
 * geometry): `top` clears the header card (12px inset + 42px card + 12px), and
 * `bottom` the size dock; `right` is wider than `left` by the half of the add
 * rail that overhangs the last frame's right edge, so revealing it never makes
 * the board scroll. Every frame's header sits in `FRAME_HEAD` above its screen.
 */
export const BOARD_PAD = { top: 66, right: 24, bottom: 76, left: 16 } as const;
export const FRAME_GAP = 20;
/** A frame's header row, plus the room around it, above its screen. */
export const FRAME_HEAD = 34;
/** How far a frame's header sits above its screen, px. */
export const FRAME_HEAD_GAP = 6;

/** The Width slider's range. */
export const MIN_WIDTH = 360;
export const MAX_WIDTH = 2560;
/** A slider width moved this close to a preset snaps onto it. */
export const SNAP_PX = 28;

/** The zoom slider's range, as scales. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 2;

export interface Room {
  w: number;
  h: number;
}

/**
 * The space ONE of `n` frames has on a canvas whose scroll viewport is `canvas`:
 * the board padding, the gaps and each frame's header taken out.
 */
export function roomPerFrame(canvas: Room, n: number): Room {
  const count = Math.max(1, n);
  return {
    w: Math.max(
      1,
      (canvas.w - BOARD_PAD.left - BOARD_PAD.right - FRAME_GAP * (count - 1)) /
        count,
    ),
    h: Math.max(1, canvas.h - BOARD_PAD.top - BOARD_PAD.bottom - FRAME_HEAD),
  };
}

/** Where one frame's SCREEN sits on the board, px from the board's top-left. */
export interface FrameBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Place `n` frames of one on-screen size (`frame`, px) on a canvas whose scroll
 * viewport is `canvas`: each frame gets its share of the room (`roomPerFrame`)
 * and sits centred in it, its header in the `FRAME_HEAD` band above. A frame
 * bigger than its share (a zoom past Fit, Whole page) widens or heightens every
 * share to it instead, and the board — `extent` — grows past the viewport, so
 * the canvas scrolls rather than overlapping or clipping frames.
 *
 * Pure: the canvas measures, this turns it into boxes.
 */
export function placeFrames(
  canvas: Room,
  n: number,
  frame: Room,
): { boxes: FrameBox[]; extent: Room } {
  const count = Math.max(1, n);
  const share = roomPerFrame(canvas, count);
  const slotW = Math.max(share.w, frame.w);
  const slotH = Math.max(share.h, frame.h);
  const top = BOARD_PAD.top + FRAME_HEAD;
  const boxes = Array.from({ length: count }, (_, i) => ({
    x: BOARD_PAD.left + i * (slotW + FRAME_GAP) + (slotW - frame.w) / 2,
    y: top + (slotH - frame.h) / 2,
    w: frame.w,
    h: frame.h,
  }));
  return {
    boxes,
    extent: {
      w: Math.max(
        canvas.w,
        BOARD_PAD.left +
          count * slotW +
          FRAME_GAP * (count - 1) +
          BOARD_PAD.right,
      ),
      h: Math.max(canvas.h, top + slotH + BOARD_PAD.bottom),
    },
  };
}

export interface FrameLayout {
  /** The logical frame size, in page pixels: what the page lays out at. */
  width: number;
  height: number;
  /**
   * How much of the page is visible: `height`, or with Whole page on, the
   * tallest page — never less than `height`.
   */
  visibleHeight: number;
  /** On-screen px per page px. */
  scale: number;
}

/**
 * Lay out the frames (they all share one size).
 *
 * `pageHeight` is the tallest page's full height, when Whole page is on and it
 * has been measured; `null` otherwise. `browserWindow` is the size a page gets
 * in this browser window (`useWindowSize`), which the This window size is.
 */
export function layoutFrames({
  room,
  size,
  browserWindow,
  zoom,
  wholePage,
  pageHeight,
}: {
  room: Room;
  size: CanvasSize;
  browserWindow: Room;
  zoom: CanvasZoom;
  wholePage: boolean;
  pageHeight: number | null;
}): FrameLayout {
  const fit = zoom === "fit";
  if (size.kind === "responsive") {
    // The viewport IS the available space, measured in page pixels at this
    // zoom. At Fit that is scale 1 — or, with Whole page on, the scale at which
    // the whole page fits the room's height.
    const page = wholePage ? pageHeight : null;
    const scale = fit
      ? page === null
        ? 1
        : Math.min(1, room.h / Math.max(page, 1))
      : zoom;
    const width = Math.round(room.w / scale);
    const height = Math.round(room.h / scale);
    return {
      width,
      height,
      visibleHeight: visible(height, wholePage, pageHeight),
      scale,
    };
  }
  const { w, h } =
    size.kind === "preset"
      ? presetSize(size.preset)
      : size.kind === "window"
        ? browserWindow
        : size;
  const visibleHeight = visible(h, wholePage, pageHeight);
  const scale = fit ? Math.min(room.w / w, room.h / visibleHeight) : zoom;
  return { width: w, height: h, visibleHeight, scale };
}

function visible(
  height: number,
  wholePage: boolean,
  pageHeight: number | null,
): number {
  return wholePage && pageHeight !== null
    ? Math.max(height, pageHeight)
    : height;
}

/**
 * A width picked on the size menu's Width slider: clamped to the slider's
 * range, and snapped onto a preset it moves to within {@link SNAP_PX} of.
 * Only a move TOWARD a preset snaps (as the slider primitive's detent does),
 * so stepping away from one — an arrow key from 1024 to 1025 — is never pulled
 * back onto it.
 */
export function snapWidth(
  w: number,
  from: number,
): {
  width: number;
  preset: PresetName | null;
} {
  const clamped = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));
  const snap = SIZE_PRESETS.find(
    (p) =>
      Math.abs(p.w - clamped) < SNAP_PX &&
      Math.abs(p.w - clamped) < Math.abs(p.w - from),
  );
  return snap
    ? { width: snap.w, preset: snap.name }
    : { width: clamped, preset: null };
}

/**
 * The size the Width slider lands on when moved from `from` to `w`, keeping
 * `height` unless it snaps onto a preset.
 */
export function sizeForWidth(
  w: number,
  from: number,
  height: number,
): CanvasSize {
  const { width, preset } = snapWidth(w, from);
  return preset !== null
    ? { kind: "preset", preset }
    : { kind: "custom", w: width, h: height };
}

/** What the size chip names the size ("Responsive", "This window", "Phone", "Custom"). */
export function sizeName(size: CanvasSize): string {
  switch (size.kind) {
    case "responsive":
      return "Responsive";
    case "window":
      return "This window";
    case "preset":
      return size.preset;
    case "custom":
      return "Custom";
  }
}

/** A zoom percentage as a clamped scale. */
export function zoomFromPercent(percent: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, percent / 100));
}
