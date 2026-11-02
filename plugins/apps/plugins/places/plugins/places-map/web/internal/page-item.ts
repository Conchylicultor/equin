import type { MapPin } from "@plugins/map/core";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { PageOverlayItem } from "@plugins/apps/plugins/places/plugins/page-overlay/core";
import {
  placeFamilyFill,
  placeKindGlyph,
} from "@plugins/page/plugins/place/web";
import type { GoogleHit } from "../components/google-result-card";
import type { DetailedHit } from "../components/google-place-card";

/** The pin type of a page's place not saved yet, laid over the map (`GeoMap.Pin` key). */
export const PAGE_ITEM_PIN_TYPE = "places.page-item";

const PIN_ID_PREFIX = "page-item:";

/**
 * A page item's ghost-pin id — by its BLOCK (the same place may sit twice on
 * a page), prefixed so it can never be a saved place's row id or a Google
 * result's pin id.
 */
export function pageItemPinId(blockId: string): string {
  return `${PIN_ID_PREFIX}${blockId}`;
}

/** The block behind a page item's pin id, or `null` for any other id. */
export function blockIdOfPin(pinId: string): string | null {
  return pinId.startsWith(PIN_ID_PREFIX)
    ? pinId.slice(PIN_ID_PREFIX.length)
    : null;
}

/** What a page item's ghost pin carries in `MapPin.data`. */
export interface PageItemPinData {
  /** Its number on the page. */
  n: number;
  /** Its kind's glyph (the page's place block's own). */
  icon: IconRef;
  /** Its family's colour (CSS), the icon's ink. */
  color: string;
}

export function pageItemPinData(item: PageOverlayItem): PageItemPinData {
  return {
    n: item.n,
    icon: placeKindGlyph(item.kind),
    color: placeFamilyFill(item.family),
  };
}

/** A page item pin's data; absent is a wiring bug. */
export function readPageItemPinData(pin: MapPin): PageItemPinData {
  const data: unknown = pin.data;
  if (
    typeof data !== "object" ||
    data === null ||
    !("n" in data) ||
    !("icon" in data) ||
    !("color" in data)
  ) {
    throw new Error(`page item pin "${pin.id}" carries no PageItemPinData`);
  }
  return data as PageItemPinData;
}

/** A page's place not saved yet, as a Google hit — what the detail card and Save take. */
export function pageItemHit(item: PageOverlayItem): DetailedHit {
  const color = placeFamilyFill(item.family);
  const hit: GoogleHit = {
    placeId: item.googlePlaceId,
    name: item.name,
    line:
      [item.category, item.address]
        .filter((p) => p !== undefined)
        .join(" · ") || undefined,
    result: undefined,
    visual: { mainColor: color, icon: placeKindGlyph(item.kind), tagNames: [] },
    offMap: false,
  };
  return {
    ...hit,
    result: {
      placeId: item.googlePlaceId,
      name: item.name,
      lat: item.position.lat,
      lng: item.position.lng,
      types: [],
      ...(item.address === undefined ? {} : { address: item.address }),
      ...(item.category === undefined ? {} : { category: item.category }),
    },
  };
}
