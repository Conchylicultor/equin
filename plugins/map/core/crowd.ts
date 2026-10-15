/**
 * How a map handles pins that crowd each other on screen. Two closed answers,
 * so a caller cannot ask for both:
 *
 * - `cluster` — nearby pins merge into one mark (`GeoMap.Cluster`) that stands
 *   for them; a click frames them.
 * - `spots` — nothing merges, every pin stays drawn (Google Maps' way). Below
 *   `nearZoom` pins are drawn far (a compact mark centred on its point), and the
 *   pins within `radiusPx` of each other form a spot whose most important pin
 *   carries the spot's size.
 *
 * Absent = neither: every pin drawn on its own, at every zoom, as a near pin.
 */
import { DEFAULT_CLUSTER_RADIUS_PX } from "./cluster";
import { DEFAULT_SPOT_NEAR_ZOOM, DEFAULT_SPOT_RADIUS_PX } from "./spots";

/** What a caller asks for; omitted numbers take the map's defaults. */
export type MapCrowdRequest =
  | { kind: "cluster"; radiusPx?: number }
  | { kind: "spots"; radiusPx?: number; nearZoom?: number };

/** What a renderer is handed: every number settled. */
export type MapCrowd =
  | { kind: "cluster"; radiusPx: number }
  | { kind: "spots"; radiusPx: number; nearZoom: number };

export function resolveCrowd(request: MapCrowdRequest): MapCrowd {
  switch (request.kind) {
    case "cluster":
      return {
        kind: "cluster",
        radiusPx: request.radiusPx ?? DEFAULT_CLUSTER_RADIUS_PX,
      };
    case "spots":
      return {
        kind: "spots",
        radiusPx: request.radiusPx ?? DEFAULT_SPOT_RADIUS_PX,
        nearZoom: request.nearZoom ?? DEFAULT_SPOT_NEAR_ZOOM,
      };
  }
}
