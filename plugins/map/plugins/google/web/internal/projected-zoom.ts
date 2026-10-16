import { useSyncExternalStore } from "react";

/**
 * The PLAN zoom: the map's zoom rounded to a whole level, once its projection
 * exists (`undefined` before) — what the pin plan (spots, clusters, near/far)
 * is computed at. A vector map zooms fractionally and fires `zoom_changed` on
 * every frame of a zoom; the rounded snapshot is unchanged until a level is
 * crossed, so React bails out and ~1000 pins are re-planned per level, never
 * per frame. Frames themselves are drawn at the exact camera (the pin canvas
 * projects each pin on every `draw()`).
 */
export function usePlanZoom(map: google.maps.Map | null): number | undefined {
  return useSyncExternalStore(
    (onChange) => {
      if (map === null) return () => {};
      const listeners = ["projection_changed", "zoom_changed"].map((event) =>
        map.addListener(event, onChange),
      );
      return () => {
        for (const l of listeners) l.remove();
      };
    },
    () => {
      if (map?.getProjection() == null) return undefined;
      const zoom = map.getZoom();
      return zoom === undefined ? undefined : Math.round(zoom);
    },
  );
}

/**
 * The map's projection once it exists (`null` before), as a store read — never
 * `map.getProjection()` in render, which the React Compiler would memoize on
 * `map` alone and keep at its first (null) answer.
 */
export function useMapProjection(
  map: google.maps.Map | null,
): google.maps.Projection | null {
  return useSyncExternalStore(
    (onChange) => {
      if (map === null) return () => {};
      const l = map.addListener("projection_changed", onChange);
      return () => l.remove();
    },
    () => map?.getProjection() ?? null,
  );
}
