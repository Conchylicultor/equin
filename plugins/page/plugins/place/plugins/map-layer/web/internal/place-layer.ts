import type { PageMapLayerResult } from "@plugins/page/plugins/map/core";
import { z } from "zod";
import type { MapPin } from "@plugins/map/core";
import type { Block } from "@plugins/page/plugins/editor/core";
import {
  PlaceFamilySchema,
  PlaceKindSchema,
  locatedPlaces,
  type PlaceFamily,
  type PlaceKind,
} from "@plugins/page/plugins/place/core";

/** The `GeoMap.Pin` type every place pin carries — the key the place pin is dispatched on. */
export const PLACE_PIN_TYPE = "place";

/**
 * What a place pin carries beyond its label: the place's kind (its glyph) and
 * family (its colour), exactly as they pick the /place card's circle.
 */
const PlacePinDataSchema = z.object({
  kind: PlaceKindSchema.optional(),
  family: PlaceFamilySchema.optional(),
});
type PlacePinData = z.infer<typeof PlacePinDataSchema>;

/** The kind and family a place pin was made with. Throws on a pin this layer did not make. */
export function placePinData(pin: MapPin): {
  kind: PlaceKind | undefined;
  family: PlaceFamily | undefined;
} {
  const { kind, family } = PlacePinDataSchema.parse(pin.data);
  return { kind, family };
}

/**
 * Every located place on the page as a pin (`locatedPlaces`: a picked place
 * with no coordinates yet is counted as unplaced, an empty `/place` block is
 * nothing, and unparseable data is the place block's own error to show).
 */
export function placeOverlays(blocks: readonly Block[]): PageMapLayerResult {
  const { located, unplaced } = locatedPlaces(blocks);
  const overlays: PageMapLayerResult["overlays"] = located.map(
    ({ blockId, name, kind, family, position }) => ({
      overlay: {
        kind: "pin",
        id: blockId,
        pinType: PLACE_PIN_TYPE,
        position,
        label: name,
        data: { kind, family } satisfies PlacePinData,
      },
      blockId,
    }),
  );
  return { overlays, unplaced };
}

export function describeUnplacedPlaces(count: number): string {
  return count === 1
    ? "1 place is not on the map yet: it has no location."
    : `${count} places are not on the map yet: they have no location.`;
}
