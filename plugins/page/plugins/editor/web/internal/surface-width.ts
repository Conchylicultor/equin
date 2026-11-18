import { createContext, useContext, useSyncExternalStore } from "react";

/**
 * The editor surface's width, in px, handed to the few blocks that grow into it
 * (`WideBlock`) — and to nothing else.
 *
 * ## Why not a CSS variable on the surface
 *
 * It used to be one (`--block-surface-width`, set inline on the surface and
 * inherited by every block). A custom property is INHERITED style: changing it
 * on an element restyles every element under it. The surface holds the whole
 * page, so the first write after a page opened restyled all of it a second
 * time — a full style recalc of ~50k elements (~250 ms) for a value read by a
 * handful of tables, or by none — and every frame of a pane resize paid the
 * same again.
 *
 * So the width is a value with subscribers: the surface measures and writes it,
 * and only a block that asks for it re-renders when it moves.
 */
export interface SurfaceWidth {
  get(): number | null;
  set(px: number): void;
  subscribe(listener: () => void): () => void;
}

export function createSurfaceWidth(): SurfaceWidth {
  let width: number | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => width,
    set(px) {
      if (px === width) return;
      width = px;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Provided by a surface that measures its width (the editor). A surface that
 * does not (the read-only renderer) leaves it unset, and a wide block there
 * simply stays in its column.
 */
export const SurfaceWidthContext = createContext<SurfaceWidth | null>(null);

const NONE = () => () => {};
const NULL = () => null;

/** The surrounding surface's width in px, or `null` while unmeasured / unpublished. */
export function useSurfaceWidth(): number | null {
  const source = useContext(SurfaceWidthContext);
  return useSyncExternalStore(
    source?.subscribe ?? NONE,
    source?.get ?? NULL,
    source?.get ?? NULL,
  );
}
