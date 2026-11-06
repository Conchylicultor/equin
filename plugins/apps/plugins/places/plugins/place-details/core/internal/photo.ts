import { z } from "zod";
import {
  assetPath,
  blob,
  defineEndpoint,
  type AssetPath,
} from "@plugins/infra/plugins/endpoints/core";
import { PHOTO_NAME_PATTERN } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { PLACE_DETAILS_NEEDS_MACHINE } from "./needs-machine";

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
  needsMachine: PLACE_DETAILS_NEEDS_MACHINE,
});

/** A place photo at `width` CSS pixels' worth of bytes, as an element loads it (`useAssetSrc`). */
export function placePhotoAsset(name: string, width: number): AssetPath {
  return assetPath(placePhoto, {}, { name, w: Math.round(width) });
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
  needsMachine: PLACE_DETAILS_NEEDS_MACHINE,
});

/** A Google place's gallery thumbnail, as an element loads it (`useAssetSrc`). */
export function placeThumbnailAsset(googlePlaceId: string): AssetPath {
  return assetPath(placeThumbnail, {}, { id: googlePlaceId });
}
