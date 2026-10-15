import type { PlaceSnapshot } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import type { Place } from "../../core";

/** A place's Google snapshot is re-fetched once it is older than this. */
export const REFRESH_AFTER_DAYS = 30;

/** At most this many places are re-fetched per run — the run's Google bill. */
export const REFRESH_BATCH = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Places fetched before this instant are due a refresh. */
export function refreshCutoff(now: Date): Date {
  return new Date(now.getTime() - REFRESH_AFTER_DAYS * DAY_MS);
}

/**
 * The columns a refresh rewrites from a fresh snapshot: what Google may have
 * changed about a place the user saved (closed, renamed, re-typed, re-linked).
 * `name` is Google's own — the user's name lives in `title`, which a refresh
 * never touches. Address and location stay as saved; `fetchedAt` is the
 * caller's instant.
 */
export function refreshedColumns(
  snapshot: PlaceSnapshot,
): Pick<
  Place,
  "name" | "businessStatus" | "primaryType" | "types" | "mapsUrl"
> {
  return {
    name: snapshot.name,
    businessStatus: snapshot.businessStatus ?? null,
    primaryType: snapshot.primaryType ?? null,
    types: snapshot.types ?? [],
    mapsUrl: snapshot.mapsUrl ?? null,
  };
}
