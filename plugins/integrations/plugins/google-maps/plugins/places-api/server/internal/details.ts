import { PlaceSnapshotSchema, type PlaceSnapshot } from "../../core";
import { PLACE_DETAILS_FIELD_MASK } from "./field-mask";
import { PLACES_BASE, placesFetch } from "./request";

/** Raw `places.get` response, limited to `PLACE_DETAILS_FIELD_MASK`. */
interface PlaceDetailsResponse {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  googleMapsUri?: string;
  primaryTypeDisplayName?: { text?: string };
  primaryType?: string;
  types?: string[];
  location?: { latitude?: number; longitude?: number };
  businessStatus?: string;
}

/**
 * Resolve one `placeId` into the snapshot a card renders.
 *
 * `sessionToken` must be the token used for the `autocomplete` calls that led
 * here — that pairing is what Google bills as a single session. Omit it for a
 * call no search led to (a background refresh): it is billed on its own.
 *
 * The mapped result is validated against `PlaceSnapshotSchema`, so a response
 * missing a name or an address throws (ZodError) instead of yielding a card
 * with blanks where the place should be.
 */
export async function placeDetails(
  apiKey: string,
  placeId: string,
  sessionToken?: string,
): Promise<PlaceSnapshot> {
  const url = new URL(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}`);
  if (sessionToken !== undefined) {
    url.searchParams.set("sessionToken", sessionToken);
  }

  const body = await placesFetch<PlaceDetailsResponse>(url, {
    method: "GET",
    apiKey,
    fieldMask: PLACE_DETAILS_FIELD_MASK,
  });

  return PlaceSnapshotSchema.parse({
    placeId: body.id ?? placeId,
    // A pure address result carries no displayName; its address IS its name.
    name: body.displayName?.text ?? body.formattedAddress,
    address: body.formattedAddress,
    category: body.primaryTypeDisplayName?.text,
    primaryType: body.primaryType,
    types: body.types,
    mapsUrl: body.googleMapsUri,
    lat: body.location?.latitude,
    lng: body.location?.longitude,
    // Google's enum default ("unused", per its docs) says nothing: absent.
    businessStatus:
      body.businessStatus === "BUSINESS_STATUS_UNSPECIFIED"
        ? undefined
        : body.businessStatus,
  });
}
