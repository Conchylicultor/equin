import { getPlacesClient } from "@plugins/integrations/plugins/google-maps/machine";
import {
  autocomplete,
  placeDetails,
  searchText,
} from "@plugins/integrations/plugins/google-maps/plugins/places-api/server";
import { billingMonthOf } from "@plugins/integrations/plugins/google-maps/plugins/usage/core";
import {
  autoTagsFor,
  PLACES_SEARCH_MAX_RESULTS,
  PLACES_SEARCH_MAX_SUGGESTIONS,
  type SavePlaceBody,
  type SavePlaceResult,
  type PlaceSearchQuery,
  type PlaceSearchResult,
} from "../../core";
import {
  insertPlace,
  placeByGoogleId,
  wantTagId,
} from "../../server/internal/places-repo";
import { listTags } from "../../server/internal/tags-repo";
import { placeIconJob } from "../../server/internal/place-icon";
import { searchBias } from "./search-bias";

// The Google half of Places: search and save call the Places API with the
// computer's Places key (auth/central), so only the desktop serves them.

/**
 * The Places search bar's Google half, at the rung of the downgrade ladder
 * the reader asked (`searchRung` over this month's live counts). A downgraded
 * answer says when the richer one comes back: the next billing month.
 */
export async function searchPlaces({
  q,
  bias,
  session,
  rung,
  month,
}: PlaceSearchQuery): Promise<PlaceSearchResult> {
  const maps = await getPlacesClient();
  if (!maps.ok) return { kind: "maps-not-configured" };
  const resumesAt = billingMonthOf(month).resetsAt.toISOString();
  if (rung === "names") {
    return {
      kind: "names",
      suggestions: (await autocomplete(maps.client, q, session)).slice(
        0,
        PLACES_SEARCH_MAX_SUGGESTIONS,
      ),
      resumesAt,
    };
  }
  const box = searchBias(bias);
  const results = await searchText(maps.client, q, {
    detail: rung === "rich" ? "rich" : "pro",
    ...(box === undefined ? {} : { bias: box }),
    maxResults: PLACES_SEARCH_MAX_RESULTS,
  });
  return rung === "rich"
    ? { kind: "rich", results }
    : { kind: "basic", results, resumesAt };
}

/**
 * Saves a Google place: resolves its details, tags it with every tag whose
 * Google types it has (recorded as `autoTags` too) plus Want to go, inserts it, and
 * queues its icon. A place saved before comes back as `already-saved`, unchanged.
 */
export async function savePlace({
  googlePlaceId,
  session,
}: SavePlaceBody): Promise<SavePlaceResult> {
  const existing = await placeByGoogleId(googlePlaceId);
  if (existing) return { kind: "already-saved", place: existing };

  const maps = await getPlacesClient();
  if (!maps.ok) return { kind: "maps-not-configured" };
  const snapshot = await placeDetails(maps.client, googlePlaceId, session);

  const tags = await listTags();
  const autoTags = autoTagsFor(snapshot.types ?? [], tags);
  const result = await insertPlace(
    { kind: "google", snapshot },
    { tags: [...autoTags, wantTagId(tags)], autoTags },
  );
  if (result.kind === "conflict") {
    // Saved concurrently between the check and the insert.
    // By the snapshot's id: the one the insert conflicted on.
    const raced = await placeByGoogleId(snapshot.placeId);
    if (!raced)
      throw new Error(`place ${googlePlaceId} neither inserted nor found`);
    return { kind: "already-saved", place: raced };
  }
  const inserted = result.place;
  await placeIconJob.enqueue({ placeId: inserted.id });
  return { kind: "saved", place: inserted };
}
