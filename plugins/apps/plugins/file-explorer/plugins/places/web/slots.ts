import { defineItemActions } from "@plugins/primitives/plugins/data-view/web";
import type { PlaceRow } from "./internal/place-row";

/** The seams of the Places sidebar. */
export const PlacesSlots = {
  /** A place row's hover actions (its own: Remove from Favorites on a pin). */
  RowActions: defineItemActions<PlaceRow>(),
};
