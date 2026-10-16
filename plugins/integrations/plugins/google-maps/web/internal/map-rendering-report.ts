import { useSyncExternalStore } from "react";

/** How Google actually drew a map: a Map ID only gives the vector map when it is a vector JavaScript Map ID. */
export type MapRendering = "vector" | "raster";

/**
 * Whether a Map ID was seen to work. `unchecked` is a settled answer — no map
 * has been drawn with this id on this page yet — not a stand-in for one.
 */
export type MapIdCheck =
  { kind: "unchecked" } | { kind: "checked"; rendering: MapRendering };

// Page-lifetime: a check of what Google did, not state worth persisting. The
// renderer reports, the Live map setup reads.
// eslint-disable-next-line scoped-store/no-module-mutable-store -- intentionally page-global: a fact about the page's Google Maps Map ID (how Google drew it), reported by a map in one surface and read by the setup pane in another; per-surface state would never let the pane see it
let reports: ReadonlyMap<string, MapRendering> = new Map();
const listeners = new Set<() => void>();

/** Record how Google drew a map created with `mapId`. Called by the map renderer once the map is idle. */
export function reportMapRendering(
  mapId: string,
  rendering: MapRendering,
): void {
  if (reports.get(mapId) === rendering) return;
  reports = new Map(reports).set(mapId, rendering);
  for (const l of listeners) l();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** The latest report for `mapId`. */
export function useMapIdCheck(mapId: string): MapIdCheck {
  const rendering = useSyncExternalStore(subscribe, () => reports.get(mapId));
  return rendering === undefined
    ? { kind: "unchecked" }
    : { kind: "checked", rendering };
}
