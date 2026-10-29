import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { SavedSymbolNameSchema } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { applyRows, removeRow } from "@plugins/network/plugins/live/core";
import { PlaceSchema } from "./schema";
import { placesEntityRef } from "./entity-refs";
import { MapsNotConfiguredSchema } from "./maps";

// Place CRUD and the icon re-pick. Every read is live (`./resources.ts`): the
// `places.places.all` / `places.tags.all` collections, which every write
// reaches through the change feed, and the `placeSearch` value. Tag writes are
// the tag-tree engine's endpoints (`placeTagTree`).

export const SavePlaceBodySchema = z.object({
  googlePlaceId: z.string().min(1),
  /**
   * The search's session token, when the pick came from an autocomplete
   * answer (the `names` rung): Google then bills the round as one session.
   * Absent for a Text Search hit — those have no session.
   */
  session: z.string().min(1).optional(),
});
export type SavePlaceBody = z.infer<typeof SavePlaceBodySchema>;

export const SavePlaceResultSchema = z.discriminatedUnion("kind", [
  /** Saved: auto-tagged from its Google types, tagged Want to go; its icon follows. */
  z.object({ kind: z.literal("saved"), place: PlaceSchema }),
  /** This Google place was saved before; nothing changed. */
  z.object({ kind: z.literal("already-saved"), place: PlaceSchema }),
  MapsNotConfiguredSchema,
]);
export type SavePlaceResult = z.infer<typeof SavePlaceResultSchema>;

/** Save a Google place: resolve its details, auto-tag it, queue its icon. */
export const savePlace = defineEndpoint({
  route: "POST /api/places/places",
  body: SavePlaceBodySchema,
  response: SavePlaceResultSchema,
  // One Places details call.
  slowThresholdMs: 10_000,
  unpredicted: {
    reason: "response",
    why: "resolves Google place details and the surface branches on the saved / already-saved / maps-not-configured result",
  },
});

/** A point on the map: where a custom place's pin goes. */
export const PlacePositionSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type PlacePosition = z.infer<typeof PlacePositionSchema>;

export const CreateCustomPlaceBodySchema = PlacePositionSchema.extend({
  /** What the user calls it — a custom place has no other name. */
  name: z.string().trim().min(1),
});
export type CreateCustomPlaceBody = z.infer<typeof CreateCustomPlaceBodySchema>;

/**
 * Drop a custom place: a pin with no Google place behind it (a closed venue, a
 * bunker, a one-off event), named by the user, tagged Want to go like a saved
 * Google place; its icon follows (Haiku, from the name alone).
 */
export const createCustomPlace = defineEndpoint({
  route: "POST /api/places/custom-places",
  body: CreateCustomPlaceBodySchema,
  response: PlaceSchema,
  unpredicted: {
    reason: "server-minted-id",
    why: "the screen selects the custom place by the id the server mints",
  },
});

export const UpdatePlaceBodySchema = z.object({
  /**
   * Rename. On a Google place it is the user's title, shown instead of
   * Google's name — `null` or blank shows Google's again. On a custom place it
   * is the place's name, so blank is refused.
   */
  title: z.string().nullable().optional(),
  /** Move a custom place's pin. A Google place stands where Google says: refused. */
  location: PlacePositionSchema.optional(),
  note: z.string().optional(),
  /**
   * The place's whole tag list, replacing the stored one — Been / Want to go
   * are toggled here like any tag. Every id must be a tag. A tag removed here
   * is removed from `autoTags` too.
   */
  tags: z.array(z.string()).optional(),
});
export type UpdatePlaceBody = z.infer<typeof UpdatePlaceBodySchema>;

export const updatePlace = defineEndpoint({
  route: "PATCH /api/places/places/:id",
  body: UpdatePlaceBodySchema,
  response: PlaceSchema,
  // Predicted from the row the reader holds (a custom place's rename IS its
  // name, a Google place's is the title over Google's; a removed tag leaves
  // `autoTags` too) — the server's rules, minus its refusals (a blank custom
  // name, a Google place's pin: the row then stays as it was). Unconfirmed
  // until the ack: no compared fields.
  effect: (on) =>
    applyRows(
      on,
      placesEntityRef,
      ({ params }) => [params.id],
      (rows, { body }) =>
        rows.map((row) => {
          const custom = row.googlePlaceId === null;
          const given =
            body.title === undefined ? undefined : trimmedOrNull(body.title);
          return {
            ...row,
            ...(body.note === undefined ? {} : { note: body.note }),
            ...(body.tags === undefined
              ? {}
              : {
                  tags: body.tags,
                  autoTags: row.autoTags.filter((t) => body.tags!.includes(t)),
                }),
            ...(given === undefined
              ? {}
              : custom
                ? given === null
                  ? {}
                  : { name: given }
                : { title: given === row.name ? null : given }),
            ...(body.location === undefined || !custom
              ? {}
              : {
                  location: {
                    ...row.location,
                    lat: body.location.lat,
                    lng: body.location.lng,
                  },
                }),
          };
        }),
    ),
});

function trimmedOrNull(text: string | null): string | null {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

export const deletePlace = defineEndpoint({
  route: "DELETE /api/places/places/:id",
  effect: (on) => removeRow(on, placesEntityRef, ({ params }) => params.id),
});

export const RegeneratePlaceIconResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("written"), icon: SavedSymbolNameSchema }),
  /** Haiku's answer named no Material Symbol; the icon is unchanged. */
  z.object({ kind: z.literal("rejected"), reason: z.string() }),
]);
export type RegeneratePlaceIconResult = z.infer<
  typeof RegeneratePlaceIconResultSchema
>;

/**
 * Re-pick the place's icon now, overwriting the current one. The Haiku call
 * runs inside the request, so the caller's pending state is exactly its
 * lifetime; the new icon also arrives through the live row.
 */
export const regeneratePlaceIcon = defineEndpoint({
  route: "POST /api/places/places/:id/icon",
  response: RegeneratePlaceIconResultSchema,
  // One Haiku call: seconds by design.
  slowThresholdMs: 45_000,
  unpredicted: {
    reason: "server-decided",
    why: "a Haiku call picks the icon and may reject it, leaving the icon unchanged",
  },
});
