import { entityRef } from "@plugins/infra/plugins/entities/core";
import { placeFields, placeTagFields } from "./fields";

// The Places entities a list reads, by reference — what a browser-safe
// declaration names them with (a collection's `from`, a presentation's
// `owner`), carrying each entity's field record. Each name is its table's:
// `server/internal/tables.ts` builds the table from the ref
// (`defineEntity(ref, meta)`).
export const placesEntityRef = entityRef("places", placeFields);
export const placeTagsEntityRef = entityRef("place_tags", placeTagFields);
