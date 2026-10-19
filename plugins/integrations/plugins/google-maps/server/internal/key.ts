import { getTokenFromCentral } from "@plugins/auth/server";
import { GOOGLE_MAPS_PROVIDER_ID } from "@plugins/auth/plugins/google-maps/core";
import type { PlacesClient } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { placesMeter } from "@plugins/integrations/plugins/google-maps/plugins/usage/server";

/**
 * A Places client — the stored key and the usage meter — or the ONE reason
 * there isn't one.
 *
 * A discriminated result, never a client with an `""` key — an empty key is
 * indistinguishable from a real one at the call site and would surface as a
 * confusing REQUEST_DENIED from Google instead of "you haven't set this up yet".
 */
export type PlacesClientResult =
  { ok: true; client: PlacesClient } | { ok: false; reason: "not-configured" };

/**
 * The Places client every server-side Places call is made with: the Maps API
 * key from the shared auth/central secrets store, and `placesMeter`, so every
 * call is counted in the usage ledger (`google-maps/usage`). The bare key is
 * never handed out — a call made with it would not be counted. Consumers call
 * this instead of touching `@plugins/auth`: this integration owns the Google
 * Maps vocabulary on their behalf.
 *
 * The provider is `kind: "apikey"`, so central's token response carries the raw
 * key as `accessToken` with `expiresAt: Number.MAX_SAFE_INTEGER`. No `scopes`
 * argument is passed: they are silently ignored for api-key accounts, so asking
 * for them would only imply a guarantee that isn't there.
 *
 * Failure modes, all loud:
 * - no key stored yet          → `{ ok: false, reason: "not-configured" }`
 * - central unreachable        → `AuthCentralOfflineError` propagates
 * - anything else from central → throws with central's own message
 */
export async function getPlacesClient(): Promise<PlacesClientResult> {
  const res = await getTokenFromCentral({
    providerId: GOOGLE_MAPS_PROVIDER_ID,
  });
  if (res.ok) {
    return {
      ok: true,
      client: { apiKey: res.accessToken, meter: placesMeter },
    };
  }
  if (res.needsConsent) return { ok: false, reason: "not-configured" };
  throw new Error(`Google Maps key unavailable: ${res.message}`);
}
