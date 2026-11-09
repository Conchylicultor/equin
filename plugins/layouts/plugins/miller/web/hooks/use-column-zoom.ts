import { useCallback, useSyncExternalStore } from "react";
import {
  type PaneStore,
  usePaneStore,
} from "@plugins/primitives/plugins/pane/web";
import type { ZoomState } from "../layout";

// Zoom is scoped per surface (per `PaneStore`): zooming a column in one
// mounted surface (one app tab) never collapses columns in another. The state
// remembers the route it was made on (see `effectiveZoom`), so a route change
// ends it without anything having to clear it.
interface SurfaceZoom {
  zoom: ZoomState | null;
  subscribers: Set<() => void>;
}

const byStore = new WeakMap<PaneStore, SurfaceZoom>();

function stateFor(store: PaneStore): SurfaceZoom {
  let s = byStore.get(store);
  if (!s) {
    s = { zoom: null, subscribers: new Set() };
    byStore.set(store, s);
  }
  return s;
}

function commit(s: SurfaceZoom, next: ZoomState | null): void {
  if (next === s.zoom) return;
  s.zoom = next;
  for (const fn of s.subscribers) fn();
}

/** This surface's zoom state, and its setter. */
export function useColumnZoom(): [
  ZoomState | null,
  (next: ZoomState | null) => void,
] {
  const store = usePaneStore();
  const s = stateFor(store);
  const zoom = useSyncExternalStore(
    (cb) => {
      s.subscribers.add(cb);
      return () => s.subscribers.delete(cb);
    },
    () => s.zoom,
    () => null,
  );
  const set = useCallback(
    (next: ZoomState | null) => {
      commit(s, next);
    },
    [s],
  );
  return [zoom, set];
}
