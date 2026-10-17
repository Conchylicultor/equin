import { z } from "zod";
import { blob, defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { PHOTO_NAME_PATTERN } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";

/** The widths a photo is served at: the card asks for one; the server clamps. */
export const PHOTO_WIDTH = { min: 200, max: 1600 } as const;

/**
 * One place photo's bytes, proxied same-origin: the Places key never reaches
 * the browser. A raw `blob()` handler (image content-type, a day's private
 * cache). 404 when Google no longer serves the name (photo names expire).
 */
export const placePhoto = defineEndpoint({
  route: "GET /api/places/photo",
  query: z.object({
    name: z.string().regex(PHOTO_NAME_PATTERN),
    w: z.coerce.number().int().optional(),
  }),
  response: blob(),
});

/** The `<img src>` of a place photo at `width` CSS pixels' worth of bytes. */
export function placePhotoUrl(name: string, width: number): string {
  const q = new URLSearchParams({ name, w: String(Math.round(width)) });
  return `/api/places/photo?${q}`;
}

/** A Google place id as the thumbnail route accepts it — also its cache file name. */
export const GOOGLE_PLACE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * A Google place's gallery thumbnail: its first photo at thumbnail width,
 * fetched once and kept on disk. A raw `blob()` handler. 404 when Google has
 * no photo of the place (or no longer knows it), 503 without a Places key.
 */
export const placeThumbnail = defineEndpoint({
  route: "GET /api/places/thumbnail",
  query: z.object({ id: z.string().regex(GOOGLE_PLACE_ID_PATTERN) }),
  response: blob(),
});

/** The `<img src>` of a Google place's gallery thumbnail. */
export function placeThumbnailUrl(googlePlaceId: string): string {
  return `/api/places/thumbnail?${new URLSearchParams({ id: googlePlaceId })}`;
}
