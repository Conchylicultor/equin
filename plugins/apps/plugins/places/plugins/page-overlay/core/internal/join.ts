import type { LatLng } from "@plugins/map/core";
import {
  placesByGoogleId,
  type Place,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import type {
  LocatedPlace,
  PlaceFamily,
  PlaceKind,
} from "@plugins/page/plugins/place/core";
import { GOOGLE_PLACE_PROVIDER_ID } from "@plugins/page/plugins/place/plugins/google/core";

/** One place of the page, as the overlay draws it. */
export interface PageOverlayItem {
  /** 1-based, in page order: the number on its pin and its row. */
  n: number;
  /** The `/place` block it comes from (unique; the same place may sit twice on a page). */
  blockId: string;
  googlePlaceId: string;
  /** The block's name, else the saved place's, else its address. */
  name: string;
  address: string | undefined;
  /** The provider's words for what it is ("Falafel restaurant"). */
  category: string | undefined;
  position: LatLng;
  kind: PlaceKind | undefined;
  family: PlaceFamily | undefined;
  /** The saved place with this Google id — `null`: not one of yours yet. */
  saved: Place | null;
}

/** A page's places joined with yours. */
export interface PageOverlayItems {
  items: PageOverlayItem[];
  /**
   * The page's places not on the overlay: picked but not located yet
   * (`locatedPlaces`' own `unplaced`), or from a provider other than Google
   * (Places cannot match or save them).
   */
  unplaced: number;
}

/**
 * The page's located places (`locatedPlaces`, in page order) joined with the
 * saved places: Google places only, numbered 1…N in page order, each matched
 * to the saved place with its Google id. `unplaced` is what `locatedPlaces`
 * could not locate plus every located place of another provider.
 */
export function joinPageOverlay(
  located: { located: readonly LocatedPlace[]; unplaced: number },
  places: readonly Place[],
): PageOverlayItems {
  const byGoogleId = placesByGoogleId(places);
  const items: PageOverlayItem[] = [];
  let other = 0;
  for (const p of located.located) {
    if (p.providerId !== GOOGLE_PLACE_PROVIDER_ID) {
      other++;
      continue;
    }
    const saved = byGoogleId.get(p.placeId) ?? null;
    items.push({
      n: items.length + 1,
      blockId: p.blockId,
      googlePlaceId: p.placeId,
      name: p.name ?? saved?.name ?? p.address ?? "Unnamed place",
      address: p.address,
      category: p.category,
      position: p.position,
      kind: p.kind,
      family: p.family,
      saved,
    });
  }
  return { items, unplaced: located.unplaced + other };
}
