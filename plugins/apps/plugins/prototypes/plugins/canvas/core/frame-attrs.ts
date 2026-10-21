/**
 * The canvas's DOM contract for a driver OUTSIDE the app (an `e2e/` script,
 * which drives the deployed app and may import only `core` and `e2e` barrels).
 *
 * Every frame's screen — the box a script photographs — carries:
 *
 * - `data-canvas-frame="<letter>"` — A, B, C… in canvas order;
 * - `data-canvas-frame-kind="prototype"`, or the frame source's id
 *   (`real-app`) — the canvas names no source, it publishes the id it was given;
 * - `data-canvas-frame-status` — `loading`, `unresolved` or `found`, so a driver
 *   waits for `found` rather than photographing a spinner, and on `unresolved`
 *   reads the frame's own text for the reason.
 *
 * Side by side, each frame also has a CARD — its header, screen and options
 * pill — carrying `data-canvas-card="<letter>"`. Swiped, the two frames share
 * one box and one header row, so there is no card and no options pill: the
 * canvas root publishes which it is drawing as `data-canvas-layout`.
 */

export const CANVAS_FRAME_ATTR = "data-canvas-frame";
export const CANVAS_FRAME_KIND_ATTR = "data-canvas-frame-kind";
export const CANVAS_FRAME_STATUS_ATTR = "data-canvas-frame-status";

export const CANVAS_CARD_ATTR = "data-canvas-card";
export const CANVAS_LAYOUT_ATTR = "data-canvas-layout";

/** Frames side by side, or — with exactly two — one swiped over the other. */
export type CanvasLayout = "side" | "swipe";

/** The kind a prototype frame publishes; a source frame publishes its id. */
export const PROTOTYPE_FRAME_KIND = "prototype";

export type CanvasFrameStatus = "loading" | "unresolved" | "found";

/** CSS selector for frames, narrowed by letter, kind and/or status. */
export function canvasFrameSelector({
  letter,
  kind,
  status,
}: {
  letter?: string;
  kind?: string;
  status?: CanvasFrameStatus;
} = {}): string {
  let sel = `[${CANVAS_FRAME_ATTR}${letter === undefined ? "" : `="${letter}"`}]`;
  if (kind !== undefined) sel += `[${CANVAS_FRAME_KIND_ATTR}="${kind}"]`;
  if (status !== undefined) sel += `[${CANVAS_FRAME_STATUS_ATTR}="${status}"]`;
  return sel;
}

/** CSS selector for a frame's card (side by side only), by letter. */
export function canvasCardSelector(letter: string): string {
  return `[${CANVAS_CARD_ATTR}="${letter}"]`;
}

/** CSS selector for the canvas root, narrowed by the layout it draws. */
export function canvasLayoutSelector(layout?: CanvasLayout): string {
  return `[${CANVAS_LAYOUT_ATTR}${layout === undefined ? "" : `="${layout}"`}]`;
}

/** The add rail's `+`: its accessible name, which an e2e script clicks by. */
export const ADD_FRAME_LABEL = "Add a frame to compare";

/** The add rail's button for one frame source, by the source's add label. */
export function compareWithLabel(addLabel: string): string {
  return `Compare with ${addLabel}`;
}

/** The canvas's layout toggle, by the layout it switches TO: its accessible name. */
export function layoutToggleLabel(layout: CanvasLayout): string {
  return layout === "swipe"
    ? "Swipe one frame over the other"
    : "Back to side by side";
}
