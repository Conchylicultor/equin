import { useState } from "react";
import { useMap } from "@vis.gl/react-google-maps";
import { groupSpots, type MapPin, type SpotPoint } from "@plugins/map/core";
import type { MapPinState, MapRendererProps } from "@plugins/map/web";
import { useProjectedZoom } from "../internal/projected-zoom";
import { OverlayPin } from "./overlay-pin";

interface SpotPinsProps {
  pins: readonly MapPin[];
  radiusPx: number;
  nearZoom: number;
  activeId: string | null;
  /** Each pin's z-index (`pinStackOrder`); the active pin's is the highest. */
  stackOrder: ReadonlyMap<string, number>;
  renderPin: MapRendererProps["renderPin"];
  onActivate: MapRendererProps["onActivate"];
}

/** Outranks any `MapPin.rank`: the selection always leads its spot. */
const ACTIVE_RANK = Number.MAX_SAFE_INTEGER;

/**
 * Pins drawn as spots (`crowd.kind === "spots"`): every pin stays on the map.
 * From `nearZoom` up each is a near pin on its tip. Below it each is a far pin
 * centred on its point, and the pins within `radiusPx` of each other form a
 * spot whose lead (the active pin, else the highest rank) is told the spot's
 * size — and drawn above every pin that is not a lead, so its count is never
 * buried. Hovering any pin of a spot hushes that spot's count, no other.
 *
 * Spots are formed in WORLD pixels (the projection's 256-px world scaled by
 * 2^zoom), like clusters: a pan never re-forms them, only a zoom does.
 */
export function SpotPins({
  pins,
  radiusPx,
  nearZoom,
  activeId,
  stackOrder,
  renderPin,
  onActivate,
}: SpotPinsProps) {
  const map = useMap();
  const zoom = useProjectedZoom(map);
  const [hoveredLead, setHoveredLead] = useState<string | null>(null);
  const projection = map?.getProjection();
  // No projection yet (the map is still initialising): nothing can be placed.
  if (map === null || zoom === undefined || projection == null) return null;

  const far = zoom < nearZoom;
  const leadOf = new Map<string, string>();
  const sizeOf = new Map<string, number>();
  if (far) {
    const scale = 2 ** zoom;
    const points: SpotPoint[] = pins.map((pin) => {
      const world = projection.fromLatLngToPoint(pin.position);
      if (world === null) {
        throw new Error(`Map projection cannot place pin ${pin.id}`);
      }
      return {
        id: pin.id,
        x: world.x * scale,
        y: world.y * scale,
        rank: pin.id === activeId ? ACTIVE_RANK : (pin.rank ?? 0),
      };
    });
    for (const spot of groupSpots(points, radiusPx)) {
      sizeOf.set(spot.lead, spot.ids.length);
      for (const id of spot.ids) leadOf.set(id, spot.lead);
    }
  }

  return (
    <>
      {pins.map((pin) => {
        const active = pin.id === activeId;
        const size = sizeOf.get(pin.id) ?? 1;
        const lead = leadOf.get(pin.id);
        const state: MapPinState = {
          active,
          scale: far ? "far" : "near",
          ...(size > 1
            ? { spot: { count: size, hushed: hoveredLead === pin.id } }
            : {}),
        };
        // A counting lead draws above every pin that is not one; the active
        // pin above everything, as its stack order already says.
        const lift = active ? 2 * pins.length : size > 1 ? pins.length : 0;
        return (
          <OverlayPin
            key={pin.id}
            position={pin.position}
            anchor={far ? "center" : "bottom"}
            label={pin.label}
            zIndex={(stackOrder.get(pin.id) ?? 1) + lift}
            onActivate={() => onActivate(pin.id)}
            onHoverChange={
              lead === undefined
                ? undefined
                : (hovered) =>
                    setHoveredLead((cur) =>
                      hovered ? lead : cur === lead ? null : cur,
                    )
            }
          >
            {renderPin(pin, state)}
          </OverlayPin>
        );
      })}
    </>
  );
}
