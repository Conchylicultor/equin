import { count, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { parseSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { placeTagIdKind, type PlaceTagId } from "../../core";
import { _placeTags } from "./tables";
import { SEED_TAGS, type SeedTagKey } from "./seed-tags";

/** The seed as rows to insert, and the id each seed key was minted. */
export interface SeedTagTree {
  rows: (typeof _placeTags.$inferInsert)[];
  idByKey: ReadonlyMap<SeedTagKey, PlaceTagId>;
}

/**
 * The seed as `place_tags` rows: each id minted, `parent` keys resolved to the
 * minted ids, rank = order among siblings in `SEED_TAGS`.
 */
export function seedTagTree(): SeedTagTree {
  const ids = new Map<string, PlaceTagId>();
  const nextRank = new Map<string | null, number>();
  const rows = SEED_TAGS.map((tag) => {
    const id = placeTagIdKind.mint();
    ids.set(tag.key, id);
    let parentId: string | null = null;
    if (tag.parent !== undefined) {
      const parent = ids.get(tag.parent);
      if (parent === undefined) {
        throw new Error(
          `seed tag ${tag.key} precedes its parent ${tag.parent}`,
        );
      }
      parentId = parent;
    }
    const rank = nextRank.get(parentId) ?? 0;
    nextRank.set(parentId, rank + 1);
    return {
      id,
      name: tag.name,
      parentId,
      role: tag.role ?? null,
      color: tag.color ?? null,
      childColors: tag.childColors ?? null,
      icon: parseSavedSymbolName(tag.icon),
      googleTypes: [...(tag.googleTypes ?? [])],
      rank,
    };
  });
  // Every SEED_TAGS key is a SeedTagKey: the map was filled from exactly them.
  return { rows, idByKey: ids as ReadonlyMap<SeedTagKey, PlaceTagId> };
}

/**
 * Seeds the tag tree on a backend whose `place_tags` is empty — a fresh install.
 * Once any tag exists (seeded, or the user's), it never runs again, so a tag the
 * user deleted or renamed stays that way. The check and the insert run under a
 * table lock, so two racing boots cannot seed two trees.
 *
 * A warm-up, not a boot barrier: it holds rows, and nothing needs it before the
 * backend serves — the tags collection is live, so the tree appears when it
 * lands. `worktree` scope: a fork inherits main's tags and so skips.
 */
export const seedPlaceTagsWarmup = defineWarmup({
  name: "places.seed-tags",
  description:
    "Creates the starter tag tree (Want to go, Been, Food, Museum, …) when no place tag exists yet.",
  scope: "worktree",
  run: async () => {
    await db.transaction(async (tx) => {
      // Serializes racing seeders: the second waits, then sees the first's rows.
      await tx.execute(
        sql`LOCK TABLE ${_placeTags} IN SHARE ROW EXCLUSIVE MODE`,
      );
      const [row] = await tx.select({ n: count() }).from(_placeTags);
      if ((row?.n ?? 0) > 0) return;
      await tx.insert(_placeTags).values(seedTagTree().rows);
    });
  },
});
