import type { Block } from "@plugins/page/plugins/editor/core";
import { PLACE_TYPE, placeBlock } from "./place-block";
import type { PlaceFamily, PlaceKind } from "./kinds";

/**
 * A picked place on a page that has coordinates: what anything drawing a
 * page's places on a map reads (the `/map` block's place layer, another app
 * showing the page's places). Optional exactly where the stored block data
 * (`PlaceDataSchema`) is — a place still resolving has no name yet.
 */
export interface LocatedPlace {
  blockId: string;
  /** Which registered provider owns `placeId` (absent on a block stored before it was kept). */
  providerId: string | undefined;
  placeId: string;
  name: string | undefined;
  address: string | undefined;
  /** The provider's own words for what it is ("Falafel restaurant"). */
  category: string | undefined;
  kind: PlaceKind | undefined;
  family: PlaceFamily | undefined;
  position: { lat: number; lng: number };
}

/**
 * Every located place among `blocks`, in block order. A place that has been
 * PICKED but has no coordinates (still resolving, or stored before `lat`/`lng`
 * were kept) is counted in `unplaced` rather than dropped. An empty `/place`
 * block — a search box with nothing chosen — is not a place yet and counts as
 * nothing. A row whose data does not parse is the place block's own error to
 * show, not its reader's.
 */
export function locatedPlaces(blocks: readonly Block[]): {
  located: LocatedPlace[];
  unplaced: number;
} {
  const located: LocatedPlace[] = [];
  let unplaced = 0;
  for (const b of blocks) {
    if (b.type !== PLACE_TYPE) continue;
    const parsed = placeBlock.safeParse(b.data);
    if (!parsed.success) continue;
    const {
      providerId,
      placeId,
      lat,
      lng,
      name,
      address,
      category,
      kind,
      family,
    } = parsed.data;
    if (placeId === undefined) continue;
    if (lat === undefined || lng === undefined) {
      unplaced++;
      continue;
    }
    located.push({
      blockId: b.id,
      providerId,
      placeId,
      name,
      address,
      category,
      kind,
      family,
      position: { lat, lng },
    });
  }
  return { located, unplaced };
}
