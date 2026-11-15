import {
  MAX_SCALE,
  areaCenter,
  clampView,
  fitScale,
  isAtScale,
  panView,
  stepScale,
  zoomAt,
  type Area,
  type Size,
  type View,
} from "@plugins/primitives/plugins/overlay/plugins/image-viewer/core";

/**
 * A zoomable comparison's geometry, as pure functions over the image viewer's
 * own (`image-viewer/core`): the same fit floor, zoom ladder, pan clamp and
 * wheel curve, so the two zoom alike.
 *
 * Coordinates are VIEWPORT pixels: the viewport is the box one side is drawn
 * in (side by side, each half). Both sides share one {@link View} — they are
 * the same size, so the same transform shows the same part of each.
 */

/** A fit the view follows when the viewport resizes. */
export type ZoomFit = "width" | "height";

export interface ZoomState {
  /** Both sides' pixel size. */
  readonly natural: Size;
  /** The viewport, once measured. Nothing is drawn before. */
  readonly viewport: Size | null;
  /** Where the sides are drawn: their top-left in the viewport, and their scale. */
  readonly view: View;
  /** The fit a resize re-applies; `null` once the user zoomed or panned by hand. */
  readonly fit: ZoomFit | null;
}

/** A box in viewport pixels. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The viewport as the image viewer's area: no controls cover its edges. */
function areaOf(viewport: Size): Area {
  return { ...viewport, top: 0, bottom: 0, side: 0 };
}

/** The smallest scale: the whole picture in the viewport (never above 1). */
export function minScale(natural: Size, viewport: Size): number {
  return fitScale(natural, areaOf(viewport));
}

/** The scale that makes the picture exactly as wide (`width`) or tall
 *  (`height`) as the viewport, held between the whole-picture floor and the
 *  largest zoom — it may enlarge, unlike the floor. */
export function fitAxisScale(
  fit: ZoomFit,
  natural: Size,
  viewport: Size,
): number {
  const exact =
    fit === "width"
      ? viewport.width / natural.width
      : viewport.height / natural.height;
  return Math.min(MAX_SCALE, Math.max(minScale(natural, viewport), exact));
}

/** A fresh zoom: fitted to the width, top first — a tall page reads from its top. */
export function initialZoom(natural: Size, fit: ZoomFit = "width"): ZoomState {
  return { natural, viewport: null, view: { scale: 1, x: 0, y: 0 }, fit };
}

/**
 * The view at `fit`. Coming from `from`, the part on screen scales with it
 * (a resize keeps the reader where they were); without one, the top.
 */
function fittedView(
  fit: ZoomFit,
  natural: Size,
  viewport: Size,
  from: View | null,
): View {
  const scale = fitAxisScale(fit, natural, viewport);
  const k = from === null ? 0 : scale / from.scale;
  return clampView(
    {
      scale,
      x: from === null ? 0 : from.x * k,
      y: from === null ? 0 : from.y * k,
    },
    natural,
    areaOf(viewport),
  );
}

/** What can happen to a zoom. */
export type ZoomAction =
  | { readonly type: "measure"; readonly viewport: Size }
  | { readonly type: "fit"; readonly fit: ZoomFit }
  | { readonly type: "actual-size" }
  | { readonly type: "step"; readonly dir: 1 | -1 }
  | {
      readonly type: "zoom-by";
      readonly factor: number;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: "pan";
      readonly from: View;
      readonly dx: number;
      readonly dy: number;
    };

export function zoomReducer(state: ZoomState, action: ZoomAction): ZoomState {
  if (action.type === "measure") {
    const { viewport } = action;
    const prev = state.viewport;
    if (
      prev !== null &&
      prev.width === viewport.width &&
      prev.height === viewport.height
    )
      return state;
    const view =
      state.fit !== null
        ? fittedView(
            state.fit,
            state.natural,
            viewport,
            prev === null ? null : state.view,
          )
        : zoomAt(
            state.view,
            state.view.scale,
            viewport.width / 2,
            viewport.height / 2,
            state.natural,
            areaOf(viewport),
          );
    return { ...state, viewport, view };
  }
  const { viewport, natural } = state;
  if (viewport === null) {
    // Not drawn yet: only a fit choice means anything, and it applies on measure.
    return action.type === "fit" ? { ...state, fit: action.fit } : state;
  }
  const area = areaOf(viewport);
  const center = areaCenter(area);
  const zoomed = (view: View): ZoomState => ({ ...state, view, fit: null });
  switch (action.type) {
    case "fit":
      return {
        ...state,
        fit: action.fit,
        view: fittedView(action.fit, natural, viewport, null),
      };
    case "actual-size":
      return zoomed(zoomAt(state.view, 1, center.x, center.y, natural, area));
    case "step":
      return zoomed(
        zoomAt(
          state.view,
          stepScale(state.view.scale, action.dir, minScale(natural, viewport)),
          center.x,
          center.y,
          natural,
          area,
        ),
      );
    case "zoom-by":
      return zoomed(
        zoomAt(
          state.view,
          state.view.scale * action.factor,
          action.x,
          action.y,
          natural,
          area,
        ),
      );
    case "pan":
      return zoomed(panView(action.from, action.dx, action.dy, natural, area));
  }
}

/** The drawn picture, in viewport pixels (it may run past the viewport). */
export function drawnBox(state: ZoomState): Box {
  const { view, natural } = state;
  return {
    left: view.x,
    top: view.y,
    width: natural.width * view.scale,
    height: natural.height * view.scale,
  };
}

/** The part of the viewport the picture covers — the comparison's frame. A
 *  picture smaller than the viewport on an axis is centred on it, so this is
 *  the picture there and the whole viewport where it overflows. */
export function visibleBox(state: ZoomState): Box | null {
  const { viewport } = state;
  if (viewport === null) return null;
  const d = drawnBox(state);
  const left = Math.max(0, d.left);
  const top = Math.max(0, d.top);
  return {
    left,
    top,
    width: Math.max(0, Math.min(viewport.width, d.left + d.width) - left),
    height: Math.max(0, Math.min(viewport.height, d.top + d.height) - top),
  };
}

/** Does the picture run past the viewport, so a drag has something to pan? */
export function canPan(state: ZoomState): boolean {
  const { viewport } = state;
  if (viewport === null) return false;
  const d = drawnBox(state);
  return d.width > viewport.width + 1 || d.height > viewport.height + 1;
}

/** Is the view at `fit`'s scale right now (the fit button reads pressed)? */
export function isAtFit(state: ZoomState, fit: ZoomFit): boolean {
  return (
    state.viewport !== null &&
    isAtScale(state.view, fitAxisScale(fit, state.natural, state.viewport))
  );
}

export function canZoomOut(state: ZoomState): boolean {
  return (
    state.viewport !== null &&
    state.view.scale > minScale(state.natural, state.viewport) + 1e-3
  );
}

export function canZoomIn(state: ZoomState): boolean {
  return state.view.scale < MAX_SCALE - 1e-3;
}

/** The fit that shows the whole picture: whichever axis runs out of room first. */
export function wholeFit(natural: Size, viewport: Size): ZoomFit {
  return fitAxisScale("width", natural, viewport) <=
    fitAxisScale("height", natural, viewport)
    ? "width"
    : "height";
}
