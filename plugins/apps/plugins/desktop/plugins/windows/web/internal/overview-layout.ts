import type { WindowId } from "../hooks/use-floating-windows";
import type { Rect } from "../hooks/use-snap";

/** Inset (px) of the overview grid from the desktop's sides and bottom. */
const PAD = 48;
/** Inset (px) of the overview grid from the desktop's top. */
const TOP = 36;
/** Height (px) each grid cell keeps under its window for the label. */
const LABEL_H = 34;
/** Rows whose centres differ by less than this (px) read as one row. */
const ROW_SLACK = 120;

/** Where one window sits in the overview. */
export interface OverviewSlot {
  id: WindowId;
  /** The window's transform from its own box to its grid cell (origin: its centre). */
  transform: string;
  /** The scale it is drawn at. */
  scale: number;
  /** Its on-screen box in the overview (desktop coords) — the click target. */
  rect: Rect;
  /** The label's anchor: horizontally centred on `x`, its top at `y`. */
  label: { x: number; y: number };
}

/**
 * The overview grid — the mockup's `enterOverview` verbatim. Windows are read
 * in rows (top to bottom, a row being windows whose centres lie within
 * {@link ROW_SLACK}px of each other), left to right inside a row; the grid has
 * about as many columns as the desktop's aspect asks for, a short last row is
 * centred, and each window scales (never past 0.9) to fit its cell above its
 * label. Pure: `boxes` are the windows' current desktop boxes, `width` ×
 * `height` the whole desktop (the shelf hides during the overview).
 */
export function layoutOverview(
  boxes: ReadonlyArray<{ id: WindowId; box: Rect }>,
  width: number,
  height: number,
): OverviewSlot[] {
  const n = boxes.length;
  if (n === 0) return [];
  const centreY = (r: Rect) => r.y + r.h / 2;
  const list = [...boxes].sort(
    (a, b) =>
      (centreY(a.box) > centreY(b.box) + ROW_SLACK ? 1 : 0) -
        (centreY(b.box) > centreY(a.box) + ROW_SLACK ? 1 : 0) ||
      a.box.x - b.box.x,
  );
  const cols = Math.max(
    1,
    Math.min(n, Math.ceil(Math.sqrt((n * (width / height)) / 1.2))),
  );
  const rows = Math.ceil(n / cols);
  const cw = (width - PAD * 2) / cols;
  const ch = (height - TOP - PAD) / rows;
  return list.map(({ id, box }, i) => {
    const r = Math.floor(i / cols);
    const inRow = Math.min(cols, n - r * cols);
    const c = i % cols;
    const cx = PAD + ((cols - inRow) * cw) / 2 + c * cw + cw / 2;
    const cy = TOP + r * ch + (ch - LABEL_H) / 2;
    const s = Math.min((cw - 32) / box.w, (ch - LABEL_H - 24) / box.h, 0.9);
    return {
      id,
      transform: `translate(${cx - (box.x + box.w / 2)}px, ${cy - (box.y + box.h / 2)}px) scale(${s})`,
      scale: s,
      rect: {
        x: cx - (box.w * s) / 2,
        y: cy - (box.h * s) / 2,
        w: box.w * s,
        h: box.h * s,
      },
      label: { x: cx, y: cy + (box.h * s) / 2 + 10 },
    };
  });
}

/**
 * "Tile all windows" — the mockup's `tileAll` verbatim: left to right, one or
 * two columns for up to four windows, three past that, every cell a free box
 * inside the work area (`width` × `workHeight`) with the snap gutter around it.
 */
export function layoutTiles(
  boxes: ReadonlyArray<{ id: WindowId; box: Rect }>,
  width: number,
  workHeight: number,
  gap: number,
): Map<WindowId, Rect> {
  const list = [...boxes].sort((a, b) => a.box.x - b.box.x);
  const n = list.length;
  const out = new Map<WindowId, Rect>();
  if (n === 0) return out;
  const cols = n <= 2 ? n : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  list.forEach(({ id }, i) => {
    const r = Math.floor(i / cols);
    const inRow = Math.min(cols, n - r * cols);
    const c = i % cols;
    const cw = (width - gap * (inRow + 1)) / inRow;
    const ch = (workHeight - gap * (rows + 1)) / rows;
    out.set(id, {
      x: gap + c * (cw + gap),
      y: gap + r * (ch + gap),
      w: cw,
      h: ch,
    });
  });
  return out;
}
