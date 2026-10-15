import { searchText } from "@plugins/integrations/plugins/google-maps/plugins/places-api/server";
import { requireMapsKey, underQuota } from "./google";
import { distanceM } from "./match";
import type { SearchPlaceOptions } from "./options";

/** The default `--radius`: the bias circle around `--near`. */
const DEFAULT_RADIUS_M = 2_000;
const MAX_RESULTS = 10;

/** `--near "48.85,2.35"` as a point; a malformed value throws. */
export function parseNear(near: string): { lat: number; lng: number } {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(near);
  const lat = Number(match?.[1]);
  const lng = Number(match?.[2]);
  if (!match || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error(`--near must be "<lat>,<lng>", got "${near}"`);
  }
  return { lat, lng };
}

/**
 * `./singularity places search-place "<query>"` — Google's top hits for a
 * query, for a human or a research agent deciding a Mapstr row by hand
 * (`--overrides`). Read-only: one Text Search, no DB write.
 */
export async function searchPlace(
  query: string,
  opts: SearchPlaceOptions,
): Promise<void> {
  const near = opts.near === undefined ? undefined : parseNear(opts.near);
  const radiusM =
    opts.radius === undefined ? DEFAULT_RADIUS_M : Number(opts.radius);
  if (!Number.isFinite(radiusM) || radiusM <= 0 || radiusM > 50_000) {
    throw new Error(
      `--radius must be metres in (0, 50000], got "${opts.radius}"`,
    );
  }
  const key = await requireMapsKey();
  const hits = await underQuota(() =>
    searchText(key, query, {
      maxResults: MAX_RESULTS,
      ...(near === undefined ? {} : { bias: { ...near, radiusM } }),
      ...(opts.lang === undefined ? {} : { languageCode: opts.lang }),
    }),
  );
  if (hits.length === 0) {
    console.log("no results");
    return;
  }
  hits.forEach((hit, i) => {
    const distance =
      near === undefined ? "" : ` · ${Math.round(distanceM(near, hit))} m`;
    const status =
      hit.businessStatus === undefined ? "" : ` · ${hit.businessStatus}`;
    console.log(`${i + 1}. ${hit.name}${distance}${status}`);
    console.log(`   id: ${hit.placeId}`);
    console.log(`   address: ${hit.address ?? "(none)"}`);
    console.log(`   types: ${hit.types.join(", ") || "(none)"}`);
    console.log(`   at: ${hit.lat},${hit.lng}`);
  });
}
