import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { getMapsKey } from "@plugins/integrations/plugins/google-maps/server";
import {
  autocomplete,
  placeDetails,
} from "@plugins/integrations/plugins/google-maps/plugins/places-api/server";
import {
  autoTagsFor,
  placeIdKind,
  statusTagIds,
  type Place,
  type SavePlaceBody,
  type SavePlaceResult,
  type PlaceSearchResult,
  type UpdatePlaceBody,
} from "../../core";
import { _places } from "./tables";
import { listTags } from "./tags-repo";
import { editPlaceTags } from "./tag-edits";
import { placeIconJob } from "./place-icon";

// Place reads and writes. Rows reach the UI through the live `places.places`
// collection; these return the written row for the caller's own use.

export async function requirePlace(id: string): Promise<Place> {
  const [place] = await db
    .select()
    .from(_places)
    .where(eq(_places.id, placeIdKind.key(id)));
  if (!place) throw new HttpError(404, `Unknown place: ${id}`);
  return place;
}

async function placeByGoogleId(
  googlePlaceId: string,
): Promise<Place | undefined> {
  const [place] = await db
    .select()
    .from(_places)
    .where(eq(_places.googlePlaceId, googlePlaceId));
  return place;
}

export async function searchPlaces(
  q: string,
  session: string,
): Promise<PlaceSearchResult> {
  const key = await getMapsKey();
  if (!key.ok) return { kind: "maps-not-configured" };
  return { kind: "ok", suggestions: await autocomplete(key.key, q, session) };
}

/**
 * Saves a Google place: resolves its details, tags it with every tag whose
 * Google types it has (recorded as `autoTags` too) plus `todo`, inserts it, and
 * queues its icon. A place saved before comes back as `already-saved`, unchanged.
 */
export async function savePlace({
  googlePlaceId,
  session,
}: SavePlaceBody): Promise<SavePlaceResult> {
  const existing = await placeByGoogleId(googlePlaceId);
  if (existing) return { kind: "already-saved", place: existing };

  const key = await getMapsKey();
  if (!key.ok) return { kind: "maps-not-configured" };
  const snapshot = await placeDetails(key.key, googlePlaceId, session);
  if (snapshot.lat === undefined || snapshot.lng === undefined) {
    // A place with no coordinates cannot be drawn on the map.
    throw new HttpError(
      502,
      `Google returned no location for "${snapshot.name}"`,
    );
  }

  const types = snapshot.types ?? [];
  const tags = await listTags();
  const autoTags = autoTagsFor(types, tags);
  const [inserted] = await db
    .insert(_places)
    .values({
      id: placeIdKind.mint(),
      googlePlaceId,
      name: snapshot.name,
      address: snapshot.address,
      location: {
        lat: snapshot.lat,
        lng: snapshot.lng,
        address: snapshot.address,
      },
      primaryType: snapshot.primaryType ?? null,
      types,
      mapsUrl: snapshot.mapsUrl ?? null,
      icon: null,
      tags: [...autoTags, statusTagIds(tags).todo],
      autoTags,
    })
    .onConflictDoNothing({ target: _places.googlePlaceId })
    .returning();
  if (!inserted) {
    // Saved concurrently between the check and the insert.
    const raced = await placeByGoogleId(googlePlaceId);
    if (!raced)
      throw new Error(`place ${googlePlaceId} neither inserted nor found`);
    return { kind: "already-saved", place: raced };
  }
  await placeIconJob.enqueue({ placeId: inserted.id });
  return { kind: "saved", place: inserted };
}

export async function updatePlace(
  id: string,
  body: UpdatePlaceBody,
): Promise<Place> {
  const place = await requirePlace(id);
  const edit = editPlaceTags(place, body, await listTags());
  if (!edit.ok) throw new HttpError(400, edit.reason);
  const [updated] = await db
    .update(_places)
    .set({ note: body.note, tags: edit.tags, autoTags: edit.autoTags })
    .where(eq(_places.id, place.id))
    .returning();
  if (!updated) throw new HttpError(404, `Unknown place: ${id}`);
  return updated;
}

export async function deletePlace(id: string): Promise<void> {
  const deleted = await db
    .delete(_places)
    .where(eq(_places.id, placeIdKind.key(id)))
    .returning({ id: _places.id });
  if (deleted.length === 0) throw new HttpError(404, `Unknown place: ${id}`);
}
