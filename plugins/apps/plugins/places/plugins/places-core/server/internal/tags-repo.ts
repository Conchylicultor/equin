import { eq, isNull, max, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import {
  placeTagIdKind,
  wouldCycle,
  type CreatePlaceTagBody,
  type PlaceTag,
  type UpdatePlaceTagBody,
} from "../../core";
import { _places, _placeTags } from "./tables";
import { replaceDeletedTag } from "./tag-edits";

// Tag CRUD. Every failure throws an `HttpError` (404 unknown tag, 400 a refused
// edit); the rows reach the UI through the live `places.tags.all` collection.

export async function listTags(): Promise<PlaceTag[]> {
  return db.select().from(_placeTags);
}

export async function requireTag(id: string): Promise<PlaceTag> {
  const [tag] = await db
    .select()
    .from(_placeTags)
    .where(eq(_placeTags.id, placeTagIdKind.key(id)));
  if (!tag) throw new HttpError(404, `Unknown tag: ${id}`);
  return tag;
}

async function nextRank(parentId: string | null): Promise<number> {
  const [row] = await db
    .select({ rank: max(_placeTags.rank) })
    .from(_placeTags)
    .where(
      parentId === null
        ? isNull(_placeTags.parentId)
        : eq(_placeTags.parentId, parentId),
    );
  const top = row?.rank;
  return top === null || top === undefined ? 0 : top + 1;
}

export async function createTag(body: CreatePlaceTagBody): Promise<PlaceTag> {
  const parentId = body.parentId ?? null;
  if (parentId !== null) await requireTag(parentId);
  const [tag] = await db
    .insert(_placeTags)
    .values({
      id: placeTagIdKind.mint(),
      name: body.name,
      parentId,
      color: body.color ?? null,
      icon: body.icon ?? null,
      googleTypes: body.googleTypes ?? [],
      rank: await nextRank(parentId),
    })
    .returning();
  if (!tag) throw new Error("place_tags insert returned no row");
  return tag;
}

export async function updateTag(
  id: string,
  body: UpdatePlaceTagBody,
): Promise<PlaceTag> {
  await requireTag(id);
  if (body.parentId !== undefined && body.parentId !== null) {
    await requireTag(body.parentId);
    if (wouldCycle(id, body.parentId, await listTags())) {
      throw new HttpError(400, "A tag cannot move under itself");
    }
  }
  const [tag] = await db
    .update(_placeTags)
    .set({
      name: body.name,
      parentId: body.parentId,
      color: body.color,
      icon: body.icon,
      googleTypes: body.googleTypes,
      rank: body.rank,
    })
    .where(eq(_placeTags.id, placeTagIdKind.key(id)))
    .returning();
  if (!tag) throw new HttpError(404, `Unknown tag: ${id}`);
  return tag;
}

/**
 * Deletes a tag: its children move up to its parent and every place carrying it
 * gets the parent instead, in one transaction.
 */
export async function deleteTag(id: string): Promise<void> {
  const tag = await requireTag(id);
  // The status logic resolves its tags by role: those are never deleted.
  if (tag.role !== null) {
    throw new HttpError(400, `The ${tag.name} tag cannot be deleted`);
  }
  await db.transaction(async (tx) => {
    await tx
      .update(_placeTags)
      .set({ parentId: tag.parentId })
      .where(eq(_placeTags.parentId, tag.id));
    const carrying = await tx
      .select({
        id: _places.id,
        tags: _places.tags,
        autoTags: _places.autoTags,
      })
      .from(_places)
      .where(sql`${_places.tags} @> ${JSON.stringify([tag.id])}::jsonb`);
    for (const place of carrying) {
      await tx
        .update(_places)
        .set(replaceDeletedTag(place, tag.id, tag.parentId))
        .where(eq(_places.id, place.id));
    }
    await tx.delete(_placeTags).where(eq(_placeTags.id, tag.id));
  });
}
