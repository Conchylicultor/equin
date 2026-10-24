import { eq, sql } from "drizzle-orm";
import type { TagCarrier } from "@plugins/tag-tree/plugins/engine/server";
import { _places } from "./tables";
import { replaceDeletedTag } from "./tag-edits";

/**
 * The places as carriers of the tag tree: a deleted tag is replaced, on every
 * place holding it, by its parent (dropped at the root, never duplicated) and
 * leaves the place's `autoTags` — inside the tag-tree engine's delete
 * transaction.
 */
export const placeTagsCarrier: TagCarrier = {
  async replaceDeleted(tx, deletedId, parentId) {
    const carrying = await tx
      .select({
        id: _places.id,
        tags: _places.tags,
        autoTags: _places.autoTags,
      })
      .from(_places)
      .where(sql`${_places.tags} @> ${JSON.stringify([deletedId])}::jsonb`);
    for (const place of carrying) {
      await tx
        .update(_places)
        .set(replaceDeletedTag(place, deletedId, parentId))
        .where(eq(_places.id, place.id));
    }
  },
};
