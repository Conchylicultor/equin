import { useSyncExternalStore } from "react";

/**
 * The map's zoom, once its projection exists (`undefined` before). A plain
 * number snapshot, so the store is stable between events and a re-render
 * happens only when the zoom actually changes.
 */
export function useProjectedZoom(
  map: google.maps.Map | null,
): number | undefined {
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
    () => (map?.getProjection() == null ? undefined : map.getZoom()),
  );
}
