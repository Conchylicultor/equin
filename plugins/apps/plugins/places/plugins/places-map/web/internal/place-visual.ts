import type { MapPin } from "@plugins/map/core";
import {
  runtimeSymbol,
  symbol,
  type IconRef,
} from "@plugins/ui/plugins/icons/core";
import {
  isRoleTag,
  placeFlags,
  ringColors,
  tagPath,
  type Place,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import { placeColors } from "./pin-paint";

/** The pin type the map view stamps on every saved place (`GeoMap.Pin` / `GeoMap.Cluster` key). */
export const SAVED_PLACE_PIN_TYPE = "saved-place";

/** A place no tag gives an icon to. */
export const fallbackIcon = symbol("location-on");

/**
 * How a place looks — on its pin, its cluster share, its card hero, its
 * gallery cover and its list glyph — resolved once against the tag tree, so
 * every surface paints the same thing.
 */
export interface PlaceVisual {
  /**
   * The distinct colours of its non-role tags; never empty (neutral when none).
   * Greyed when Google says it is permanently closed, so every surface draws
   * it grey.
   */
  colors: readonly string[];
  /** The first of {@link colors}: the one colour a single-colour surface wears. */
  mainColor: string;
  /** Carries Want to go: the pin is drawn solid (else pale). */
  want: boolean;
  /** Carries Been: counted by the cluster's `✓ n`, badged on the cover. */
  been: boolean;
  /**
   * The place's own icon (Haiku's pick), else the icon of its nearest tagged
   * ancestor-or-self among its tags, else a generic location pin.
   */
  icon: IconRef;
  /** Whether {@link icon} is the place's own rather than a stand-in. */
  ownIcon: boolean;
}

/** The icon of the first of `tagIds` (or its nearest ancestor) that has one. */
export function tagIcon(
  tagIds: readonly string[],
  tags: readonly PlaceTag[],
): IconRef | null {
  for (const tagId of tagIds) {
    if (isRoleTag(tagId, tags)) continue;
    const withIcon = tagPath(tagId, tags)
      .reverse()
      .find((t) => t.icon !== null);
    if (withIcon?.icon) return runtimeSymbol(withIcon.icon);
  }
  return null;
}

export function placeVisual(
  place: Place,
  tags: readonly PlaceTag[],
): PlaceVisual {
  const colors = placeColors(
    ringColors(place, tags),
    place.businessStatus === "CLOSED_PERMANENTLY",
  );
  const ownIcon = place.icon === null ? null : runtimeSymbol(place.icon);
  return {
    colors,
    mainColor: colors[0]!,
    ...placeFlags(place, tags),
    icon: ownIcon ?? tagIcon(place.tags, tags) ?? fallbackIcon,
    ownIcon: ownIcon !== null,
  };
}

/**
 * The visual a saved-place pin carries in `MapPin.data` (the map view's
 * `pinData`). A pin of this type without one is a wiring bug, so it throws
 * rather than drawing a blank pin.
 */
export function readPlaceVisual(pin: MapPin): PlaceVisual {
  const data: unknown = pin.data;
  if (
    typeof data !== "object" ||
    data === null ||
    !("colors" in data) ||
    !Array.isArray(data.colors) ||
    !("icon" in data)
  ) {
    throw new Error(
      `saved-place pin "${pin.id}" carries no PlaceVisual — pass pinData: (p) => placeVisual(p, tags)`,
    );
  }
  return data as PlaceVisual;
}
