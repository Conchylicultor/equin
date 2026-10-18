import { useCallback, type PointerEvent as ReactPointerEvent } from "react";
import {
  type Geometry,
  type WindowId,
  MIN_W,
  MIN_H,
} from "../hooks/use-floating-windows";
import {
  beginWindowInteraction,
  endWindowInteraction,
} from "../hooks/use-window-motion";

/** Which edges a handle drags; corners set two. */
interface Edge {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

/**
 * Apply one drag delta to the box per the handle's active edges, clamped to the
 * minimum size. Left/top edges move the origin AND shrink, so they're clamped by
 * pinning the far edge (`x + w` / `y + h`) before re-deriving the near edge —
 * otherwise dragging past the minimum would invert the box. The top edge stops
 * at the desktop's top (mockup `startResize`).
 */
function applyEdge(g: Geometry, edge: Edge, dx: number, dy: number): Geometry {
  let { x, y, w, h } = g;
  if (edge.right) w = Math.max(MIN_W, w + dx);
  if (edge.bottom) h = Math.max(MIN_H, h + dy);
  if (edge.left) {
    const right = x + w;
    x = Math.min(x + dx, right - MIN_W);
    w = right - x;
  }
  if (edge.top) {
    // The top never rises above the desktop (the titlebar lives there).
    const bottom = y + h;
    y = Math.max(0, Math.min(y + dy, bottom - MIN_H));
    h = bottom - y;
  }
  return { ...g, x, y, w, h };
}

/** One absolutely-positioned hit area dragging its edge(s) via the pointer idiom. */
function Handle({
  edge,
  cursor,
  className,
  setGeo,
  windowId,
}: {
  edge: Edge;
  cursor: string;
  className: string;
  setGeo: (next: (g: Geometry) => Geometry) => void;
  windowId: WindowId;
}) {
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      // Suppress the box transition while resizing, so the edge tracks the cursor.
      beginWindowInteraction(windowId);
      let lastX = e.clientX;
      let lastY = e.clientY;
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - lastX;
        const dy = ev.clientY - lastY;
        lastX = ev.clientX;
        lastY = ev.clientY;
        if (dx !== 0 || dy !== 0) setGeo((g) => applyEdge(g, edge, dx, dy));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        endWindowInteraction(windowId);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [edge, setGeo, windowId],
  );

  return (
    <div
      onPointerDown={onPointerDown}
      // eslint-disable-next-line layout/no-adhoc-layout -- window resize handle: edge/corner hit area positioned by the perimeter edge utilities passed in className; drag chrome, not a ramp-expressible anchor
      className={`absolute ${cursor} ${className}`}
      style={{ touchAction: "none" }}
    />
  );
}

/**
 * The eight edge + corner resize handles overlaid on a window's perimeter. Each
 * reuses the `resize-handle.tsx` pointer idiom; corners get a higher z within the
 * window so they win the overlap with the edge strips they cross. Rendered only
 * while the window is in its normal state (callers hide it when min/maximized).
 */
export function WindowResizeHandles({
  setGeo,
  windowId,
}: {
  setGeo: (next: (g: Geometry) => Geometry) => void;
  windowId: WindowId;
}) {
  return (
    <>
      {/* Edges — full-length perimeter strips; resize chrome, not ramp-expressible anchors. */}
      {/* eslint-disable-next-line layout/no-adhoc-layout -- top resize edge strip spanning the window width */}
      <Handle edge={{ top: true }} cursor="cursor-n-resize" className="inset-x-0 top-0 h-1" setGeo={setGeo} windowId={windowId} />
      {/* eslint-disable-next-line layout/no-adhoc-layout -- bottom resize edge strip spanning the window width */}
      <Handle edge={{ bottom: true }} cursor="cursor-s-resize" className="inset-x-0 bottom-0 h-1" setGeo={setGeo} windowId={windowId} />
      {/* eslint-disable-next-line layout/no-adhoc-layout -- left resize edge strip spanning the window height */}
      <Handle edge={{ left: true }} cursor="cursor-w-resize" className="inset-y-0 left-0 w-1" setGeo={setGeo} windowId={windowId} />
      {/* eslint-disable-next-line layout/no-adhoc-layout -- right resize edge strip spanning the window height */}
      <Handle edge={{ right: true }} cursor="cursor-e-resize" className="inset-y-0 right-0 w-1" setGeo={setGeo} windowId={windowId} />
      {/* Corners (size-3 hit area, raised over the edge strips). */}
      <Handle edge={{ top: true, left: true }} cursor="cursor-nw-resize" className="top-0 left-0 z-raised size-3" setGeo={setGeo} windowId={windowId} />
      <Handle edge={{ top: true, right: true }} cursor="cursor-ne-resize" className="top-0 right-0 z-raised size-3" setGeo={setGeo} windowId={windowId} />
      <Handle edge={{ bottom: true, left: true }} cursor="cursor-sw-resize" className="bottom-0 left-0 z-raised size-3" setGeo={setGeo} windowId={windowId} />
      <Handle edge={{ bottom: true, right: true }} cursor="cursor-se-resize" className="bottom-0 right-0 z-raised size-3" setGeo={setGeo} windowId={windowId} />
    </>
  );
}
