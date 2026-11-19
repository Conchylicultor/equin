import { useRef, useState, useSyncExternalStore } from "react";
import type { MapBounds } from "@plugins/map/core";

/**
 * What the map beside the panel shows, as far as "In view" goes: not known
 * yet (the camera has not rested), no map at all (no renderer, or it is
 * blocked — so nothing is in view and the panel lists every place), or the
 * part of the map the chrome leaves uncovered.
 */
export type PanelMapView =
  | { kind: "pending" }
  | { kind: "no-map" }
  | { kind: "visible"; bounds: MapBounds };

/** Where the Places map last came to rest. */
export interface CameraRestState {
  /** The whole area the map shows (what a search is biased to); null before the first rest. */
  bounds: MapBounds | null;
  /** What the side panel's "In view" reads. */
  view: PanelMapView;
}

/**
 * The Places map's camera rest, held OUTSIDE the screen's React state and
 * read where it is used ({@link useCameraRest}). Google reports a rest
 * (`idle`) on every frame of a window resize — the visible area changed — and
 * held as screen state each one re-rendered the whole screen (~1,000 fibers,
 * the toolbar, both DataViews), 40 times a second, for readers that mostly
 * ask "did the rounded box change?". So the screen writes here, and each
 * reader re-renders only when the part it selects changes.
 */
export interface CameraRestStore {
  get(): CameraRestState;
  subscribe(listener: () => void): () => void;
  /** A rest, as `MapView`'s `onCameraRest` reports it. */
  rest(bounds: MapBounds, visible: MapBounds): void;
  /** No map can be drawn: nothing is in view. */
  noMap(): void;
}

export function boundsEqual(a: MapBounds | null, b: MapBounds | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.south === b.south &&
    a.west === b.west &&
    a.north === b.north &&
    a.east === b.east
  );
}

function viewEqual(a: PanelMapView, b: PanelMapView): boolean {
  if (a.kind === "visible" && b.kind === "visible") {
    return boundsEqual(a.bounds, b.bounds);
  }
  return a.kind === b.kind;
}

export function createCameraRestStore(): CameraRestStore {
  let state: CameraRestState = { bounds: null, view: { kind: "pending" } };
  const listeners = new Set<() => void>();
  const write = (next: CameraRestState) => {
    // A rest where the last one was (a padding re-report, a settle) is not news.
    if (
      boundsEqual(state.bounds, next.bounds) &&
      viewEqual(state.view, next.view)
    )
      return;
    state = next;
    for (const l of listeners) l();
  };
  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rest: (bounds, visible) =>
      write({ bounds, view: { kind: "visible", bounds: visible } }),
    noMap: () => write({ ...state, view: { kind: "no-map" } }),
  };
}

/** One store for the lifetime of the calling component (the Places screen). */
export function useCameraRestStore(): CameraRestStore {
  const [store] = useState(createCameraRestStore);
  return store;
}

/**
 * The part of the camera rest `select` picks, re-rendering the caller only
 * when it changes by `equal` (identity by default) — a selection equal to the
 * last one keeps the last one's identity.
 */
export function useCameraRest<T>(
  store: CameraRestStore,
  select: (state: CameraRestState) => T,
  equal: (a: T, b: T) => boolean = Object.is,
): T {
  const last = useRef<{ value: T } | null>(null);
  const read = () => {
    const value = select(store.get());
    const held = last.current;
    if (held !== null && equal(held.value, value)) return held.value;
    last.current = { value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, read, read);
}

const round = (n: number, decimals: number) => Number(n.toFixed(decimals));

/**
 * The map's whole area rounded to `decimals` (3: ~100 m) — what a search
 * bias and an "off the map" mark read: a camera settling a pixel further, or
 * a window resized by a few pixels, is the same box. `null` before the first
 * rest.
 */
export function roundedBounds(
  state: CameraRestState,
  decimals = 3,
): MapBounds | null {
  const b = state.bounds;
  if (b === null) return null;
  return {
    south: round(b.south, decimals),
    west: round(b.west, decimals),
    north: round(b.north, decimals),
    east: round(b.east, decimals),
  };
}
