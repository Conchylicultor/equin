import { defineIdKind, type IdOf } from "@plugins/ids/core";

/**
 * The Places app's prefixed id kinds (`plugins/ids`):
 *
 * - `place` — a saved place (`places.id`), minted on save.
 * - `ptag` — a tag (`place_tags.id`), minted on create and by the seed alike.
 *   The status tags are found by their `role` column, never by id.
 */
export const placeIdKind = defineIdKind({ prefix: "place", label: "Place" });

export const placeTagIdKind = defineIdKind({ prefix: "ptag", label: "Tag" });

export type PlaceId = IdOf<typeof placeIdKind>;
export type PlaceTagId = IdOf<typeof placeTagIdKind>;
