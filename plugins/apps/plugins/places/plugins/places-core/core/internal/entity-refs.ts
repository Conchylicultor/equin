import { entityRef } from "@plugins/infra/plugins/entities/core";
import { tagTreeEntityRef } from "@plugins/tag-tree/plugins/engine/core";
import { placeFields, placeTagExtraFields } from "./fields";
import { placeTagIdKind } from "./id-kinds";

// The Places entities a list reads, by reference — what a browser-safe
// declaration names them with (a collection's `from`, a presentation's
// `owner`), carrying each entity's field record. Each name is its table's:
// `server/internal/tables.ts` builds the table from the ref
// (`defineEntity(ref, meta)`, `defineTagTreeTable(ref, meta)`).
export const placesEntityRef = entityRef("places", placeFields);

/**
 * The one nested tag tree, a `tag-tree` tree: the base tag columns plus the
 * Places extras (Google types, role).
 */
export const placeTagsEntityRef = tagTreeEntityRef("place_tags", {
  idKind: placeTagIdKind,
  extraFields: placeTagExtraFields,
});
