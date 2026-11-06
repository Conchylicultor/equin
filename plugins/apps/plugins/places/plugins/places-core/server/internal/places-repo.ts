import { eq } from "drizzle-orm";
import { db, type DbExecutor } from "@plugins/database/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import type { PlaceSnapshot } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import {
  isCustomPlace,
  placeIdKind,
  tagIdByRole,
  type CreateCustomPlaceBody,
  type Place,
  type PlaceId,
  type UpdatePlaceBody,
} from "../../core";
import { _places } from "./tables";
import { listTags } from "./tags-repo";
import { editPlaceTags } from "./tag-edits";
import { placeIconJob } from "./place-icon";
import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";

// Place reads and writes. Rows reach the UI through the live
// `places.places.all` collection; these return the written row for the
// caller's own use.

export async function requirePlace(id: string): Promise<Place> {
  const [place] = await db
    .select()
    .from(_places)
    .where(eq(_places.id, placeIdKind.key(id)));
  if (!place) throw new HttpError(404, `Unknown place: ${id}`);
  return place;
}

export async function placeByGoogleId(
  googlePlaceId: string,
): Promise<Place | undefined> {
  const [place] = await db
    .select()
    .from(_places)
    .where(eq(_places.googlePlaceId, googlePlaceId));
  return place;
}

/**
 * The seed creates Want to go and a role tag cannot be deleted: a tree without
 * it is broken, so this throws.
 */
export function wantTagId(tags: Parameters<typeof tagIdByRole>[0]): string {
  const want = tagIdByRole(tags, "want");
  if (want === undefined) {
    throw new Error("The place tag tree has no Want to go (role want) tag");
  }
  return want;
}

/**
 * Drops a custom place — a pin with no Google place behind it — tagged Want to
 * go like a saved Google place, and queues its icon (Haiku picks it from the
 * name: there is no Google type to read).
 */
export async function createCustomPlace({
  name,
  lat,
  lng,
}: CreateCustomPlaceBody): Promise<Place> {
  const tags = await listTags();
  const result = await insertPlace(
    { kind: "custom", name, address: "", lat, lng },
    { tags: [wantTagId(tags)], autoTags: [] },
  );
  if (result.kind === "conflict") {
    throw new Error("a custom place cannot conflict: it has no Google id");
  }
  await placeIconJob.enqueue({ placeId: result.place.id });
  return result.place;
}

/**
 * A place to add: a Google place (its snapshot, under the user's own title
 * when they gave one), or a custom place the user named and pinned. A custom
 * place carries nothing Google-shaped — the `places_custom_no_google` check
 * would refuse it anyway.
 */
export type NewPlace =
  | { kind: "google"; snapshot: PlaceSnapshot; title?: string | null }
  | {
      kind: "custom";
      name: string;
      /** Whatever address it was known by; "" when none. */
      address: string;
      lat: number;
      lng: number;
    };

/** What the caller decided about a place, beside where it comes from. */
export interface InsertPlaceExtras {
  /** Its id, when the caller holds one (a fixture's); minted when omitted. */
  id?: PlaceId;
  /** Every tag id the place carries, role tags included. */
  tags: string[];
  /** The subset of `tags` set from its Google types (`autoTags ⊆ tags`). */
  autoTags: string[];
  note?: string;
  /** When it was saved; now when omitted (an import carries the original date). */
  createdAt?: Date;
  /**
   * Its map icon, when the caller already knows it (an import carrying the
   * user's icons, a fixture); null — Haiku picks one later — when omitted.
   */
  icon?: SavedSymbolName;
}

export type InsertPlaceResult =
  | { kind: "inserted"; place: Place }
  /** A place with this Google id is already saved; nothing was written. */
  | { kind: "conflict" };

/**
 * Inserts one place — the one insert every path that adds a place shares (the
 * Save endpoint, a dropped custom pin, the Mapstr import). It queues no icon:
 * the caller decides that. A Google snapshot with no coordinates cannot be
 * drawn on the map, so it throws.
 */
export async function insertPlace(
  place: NewPlace,
  extras: InsertPlaceExtras,
  /** The transaction to insert in (the import's wipe-and-refill); `db` when omitted. */
  exec: DbExecutor = db,
): Promise<InsertPlaceResult> {
  const values = {
    id: extras.id ?? placeIdKind.mint(),
    ...placeColumns(place),
    icon: extras.icon ?? null,
    tags: extras.tags,
    autoTags: extras.autoTags,
    ...(extras.note === undefined ? {} : { note: extras.note }),
    ...(extras.createdAt === undefined ? {} : { createdAt: extras.createdAt }),
  };
  if (place.kind === "custom") {
    const [inserted] = await exec.insert(_places).values(values).returning();
    if (!inserted) throw new Error(`custom place "${place.name}" not inserted`);
    return { kind: "inserted", place: inserted };
  }
  const [inserted] = await exec
    .insert(_places)
    .values(values)
    .onConflictDoNothing({ target: _places.googlePlaceId })
    .returning();
  return inserted
    ? { kind: "inserted", place: inserted }
    : { kind: "conflict" };
}

/** The columns a new place's origin decides. */
function placeColumns(place: NewPlace) {
  switch (place.kind) {
    case "google": {
      const { snapshot } = place;
      if (snapshot.lat === undefined || snapshot.lng === undefined) {
        throw new HttpError(
          502,
          `Google returned no location for "${snapshot.name}"`,
        );
      }
      return {
        googlePlaceId: snapshot.placeId,
        name: snapshot.name,
        title: titleOver(snapshot.name, place.title ?? null),
        address: snapshot.address,
        location: {
          lat: snapshot.lat,
          lng: snapshot.lng,
          address: snapshot.address,
        },
        primaryType: snapshot.primaryType ?? null,
        types: snapshot.types ?? [],
        mapsUrl: snapshot.mapsUrl ?? null,
        businessStatus: snapshot.businessStatus ?? null,
      };
    }
    case "custom": {
      const name = place.name.trim();
      if (name === "") throw new HttpError(400, "A custom place needs a name");
      return {
        googlePlaceId: null,
        name,
        title: null,
        address: place.address,
        location: {
          lat: place.lat,
          lng: place.lng,
          ...(place.address === "" ? {} : { address: place.address }),
        },
        primaryType: null,
        types: [],
        mapsUrl: null,
        businessStatus: null,
      };
    }
  }
}

/** A name as given: trimmed, and blank is none. */
function nameOrNull(name: string | null): string | null {
  const trimmed = name?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * A Google place's title as stored: none when blank or when it IS Google's
 * name — so Google's name shows, and keeps up with Google's renames.
 */
function titleOver(googleName: string, title: string | null): string | null {
  const given = nameOrNull(title);
  return given === googleName ? null : given;
}

/**
 * The rename / move columns of an update. A Google place's title is the
 * user's name over Google's (blank clears it) and its location is Google's;
 * a custom place's rename IS its name (blank refused) and its pin moves.
 */
function identityColumns(
  place: Place,
  { title, location }: Pick<UpdatePlaceBody, "title" | "location">,
): Partial<Pick<Place, "title" | "name" | "location">> {
  if (isCustomPlace(place)) {
    const name = title === undefined ? undefined : nameOrNull(title);
    if (name === null) {
      throw new HttpError(400, "A custom place needs a name");
    }
    return {
      ...(name === undefined ? {} : { name }),
      ...(location === undefined
        ? {}
        : {
            location: {
              ...place.location,
              lat: location.lat,
              lng: location.lng,
            },
          }),
    };
  }
  if (location !== undefined) {
    throw new HttpError(
      400,
      "A Google place stands where Google says; only a custom place moves",
    );
  }
  return title === undefined ? {} : { title: titleOver(place.name, title) };
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
    .set({
      ...identityColumns(place, body),
      note: body.note,
      tags: edit.tags,
      autoTags: edit.autoTags,
    })
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
