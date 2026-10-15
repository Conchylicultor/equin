import { useMap } from "@vis.gl/react-google-maps";
import {
  cameraFor,
  clusterPins,
  type ClusterPoint,
  type LatLng,
  type MapPin,
} from "@plugins/map/core";
import type { MapRendererProps } from "@plugins/map/web";
import { OverlayPin } from "./overlay-pin";
import { useProjectedZoom } from "../internal/projected-zoom";

/** How far a click on a cluster whose pins share one spot zooms in. */
const STACKED_CLUSTER_ZOOM_STEP = 2;

interface ClusteredPinsProps {
  pins: readonly MapPin[];
  radiusPx: number;
  activeId: string | null;
  /** Each pin's z-index (`pinStackOrder`); the active pin's is the highest. */
  stackOrder: ReadonlyMap<string, number>;
  renderPin: MapRendererProps["renderPin"];
  renderCluster: MapRendererProps["renderCluster"];
  onActivate: MapRendererProps["onActivate"];
  /** Room kept around a cluster's pins when a click frames them (the covered edges included). */
  fitPadding: google.maps.Padding;
}

/**
 * Pins drawn with clustering: at the current zoom, pins that crowd each other
 * on screen merge into one cluster mark; a lone pin is drawn as usual.
 *
 * Clustering runs in WORLD pixels (the projection's 256-px world scaled by
 * 2^zoom), which depend on the zoom alone — a pan never re-clusters, only a
 * zoom does. The active pin is left out, so the selection is always its own pin.
 */
export function ClusteredPins({
  pins,
  radiusPx,
  activeId,
  stackOrder,
  renderPin,
  renderCluster,
  onActivate,
  fitPadding,
}: ClusteredPinsProps) {
  const map = useMap();
  const zoom = useProjectedZoom(map);
  const projection = map?.getProjection();
  // No projection yet (the map is still initialising): nothing can be placed,
  // so nothing is drawn — not an unclustered stand-in that then collapses.
  if (map === null || zoom === undefined || projection == null) return null;

  const scale = 2 ** zoom;
  const byId = new Map(pins.map((p) => [p.id, p]));
  const active = activeId === null ? undefined : byId.get(activeId);
  const points: ClusterPoint[] = [];
  for (const pin of pins) {
    if (pin.id === activeId) continue;
    const world = projection.fromLatLngToPoint(pin.position);
    if (world === null) {
      throw new Error(`Map projection cannot place pin ${pin.id}`);
    }
    points.push({ id: pin.id, x: world.x * scale, y: world.y * scale });
  }

  const zoomTo = (members: readonly MapPin[]) => {
    const camera = cameraFor(members.map((m) => m.position));
    switch (camera.kind) {
      case "none":
        return;
      case "point":
        // Every member is on the same spot: no zoom separates them, so step in.
        map.setCenter(camera.center);
        map.setZoom(zoom + STACKED_CLUSTER_ZOOM_STEP);
        return;
      case "bounds":
        map.fitBounds(camera.bounds, fitPadding);
        return;
    }
  };

  return (
    <>
      {clusterPins(points, radiusPx).map((group) => {
        const members = group.ids.map((id) => {
          const pin = byId.get(id);
          if (pin === undefined) throw new Error(`Unknown clustered pin ${id}`);
          return pin;
        });
        const [seed] = members;
        if (seed === undefined) throw new Error("Empty pin cluster");
        if (members.length === 1) {
          return (
            <OverlayPin
              key={seed.id}
              position={seed.position}
              label={seed.label}
              zIndex={stackOrder.get(seed.id) ?? 1}
              onActivate={() => onActivate(seed.id)}
            >
              {renderPin(seed, { active: false, scale: "near" })}
            </OverlayPin>
          );
        }
        return (
          <OverlayPin
            key={`cluster:${seed.id}`}
            position={centroid(members)}
            anchor="center"
            label={`${members.length} pins — zoom in`}
            zIndex={stackOrder.get(seed.id) ?? 1}
            onActivate={() => zoomTo(members)}
          >
            {renderCluster(members)}
          </OverlayPin>
        );
      })}
      {active === undefined ? null : (
        <OverlayPin
          key={active.id}
          position={active.position}
          label={active.label}
          zIndex={stackOrder.get(active.id) ?? 1}
          onActivate={() => onActivate(active.id)}
        >
          {renderPin(active, { active: true, scale: "near" })}
        </OverlayPin>
      )}
    </>
  );
}

/** The members' mean position — where the cluster mark sits. */
function centroid(members: readonly MapPin[]): LatLng {
  let lat = 0;
  let lng = 0;
  for (const m of members) {
    lat += m.position.lat;
    lng += m.position.lng;
  }
  return { lat: lat / members.length, lng: lng / members.length };
}
