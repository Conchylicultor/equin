import type { MapPin } from "@plugins/map/core";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import {
  autoTagsFor,
  mainColor,
  tagPath,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import { fallbackIcon, tagIcon } from "./place-visual";

/** The pin type of a Google result proposed on the map (`GeoMap.Pin` key). */
export const GOOGLE_RESULT_PIN_TYPE = "places.google-result";

const PIN_ID_PREFIX = "google:";

/** A Google result's pin id — prefixed, so it can never be a saved place's row id. */
export function googlePinId(placeId: string): string {
  return `${PIN_ID_PREFIX}${placeId}`;
}

/** The Google place id behind a result pin's id, or `null` for any other id. */
export function googlePlaceIdOfPin(pinId: string): string | null {
  return pinId.startsWith(PIN_ID_PREFIX)
    ? pinId.slice(PIN_ID_PREFIX.length)
    : null;
}

/**
 * How a Google result looks before it is saved: as it WOULD look saved — the
 * colour and icon of the tags its Google types auto-tag it with (what Save
 * gives it), else neutral and a plain pin.
 */
export interface GoogleResultVisual {
  mainColor: string;
  icon: IconRef;
  /** The auto-tags' names, leaf last ("Food › Chinese"), for "Will tag …". */
  tagNames: readonly string[];
}

export function googleResultVisual(
  googleTypes: readonly string[],
  tags: readonly PlaceTag[],
): GoogleResultVisual {
  const autoTags = autoTagsFor(googleTypes, tags);
  // The most specific auto-tag leads: a Sichuan place is "Chinese" before "Food".
  const leaf = [...autoTags].reverse();
  return {
    mainColor: mainColor({ tags: leaf }, tags),
    icon: tagIcon(leaf, tags) ?? fallbackIcon,
    tagNames: leaf
      .slice(0, 1)
      .flatMap((id) => tagPath(id, tags).map((t) => t.name)),
  };
}

/** The visual a Google result pin carries in `MapPin.data`; absent is a wiring bug. */
export function readGoogleResultVisual(pin: MapPin): GoogleResultVisual {
  const data: unknown = pin.data;
  if (
    typeof data !== "object" ||
    data === null ||
    !("mainColor" in data) ||
    !("icon" in data)
  ) {
    throw new Error(
      `Google result pin "${pin.id}" carries no GoogleResultVisual`,
    );
  }
  return data as GoogleResultVisual;
}
