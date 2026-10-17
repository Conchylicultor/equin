import { PHOTO_NAME_PATTERN, PlacesApiError } from "../../core";
import { PLACE_PHOTOS_FIELD_MASK } from "./field-mask";
import { PLACES_BASE, placesFetch } from "./request";

/**
 * One place photo's bytes (`GET /v1/{name}/media`), at most `maxWidthPx` wide.
 * The key travels as a header, never in the URL. Google answers with a
 * redirect to the image, which `fetch` follows; the returned response is the
 * image itself, for the caller to stream on. A name that is not a photo name
 * throws before any request; a refused one (an expired name) throws
 * `PlacesApiError`.
 */
export async function placePhoto(
  apiKey: string,
  name: string,
  maxWidthPx: number,
): Promise<Response> {
  if (!PHOTO_NAME_PATTERN.test(name)) {
    throw new Error(`Not a Places photo name: ${name}`);
  }
  const url = new URL(`${PLACES_BASE}/${name}/media`);
  url.searchParams.set("maxWidthPx", String(maxWidthPx));
  const res = await fetch(url, { headers: { "X-Goog-Api-Key": apiKey } });
  if (!res.ok) {
    throw new PlacesApiError(
      res.status,
      `Place photo request failed (${res.status})`,
    );
  }
  return res;
}

/**
 * The name of one place's first photo (Google's own pick, the one its Maps
 * card leads with), or `null` when Google has no photo of it. Asks only for
 * `PLACE_PHOTOS_FIELD_MASK` (IDs Only — free). A refused id throws
 * `PlacesApiError`.
 */
export async function placeFirstPhotoName(
  apiKey: string,
  placeId: string,
): Promise<string | null> {
  const url = new URL(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}`);
  const body = await placesFetch<{ photos?: { name?: string }[] }>(url, {
    method: "GET",
    apiKey,
    fieldMask: PLACE_PHOTOS_FIELD_MASK,
  });
  const name = body.photos?.[0]?.name;
  if (name === undefined) return null;
  if (!PHOTO_NAME_PATTERN.test(name)) {
    throw new Error(`Google answered a malformed photo name: ${name}`);
  }
  return name;
}
