import { z } from "zod";
import { and, asc, eq, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  defineJob,
  NonRetryableError,
} from "@plugins/infra/plugins/jobs/server";
import { getPlacesClient } from "@plugins/integrations/plugins/google-maps/server";
import {
  PlacesApiError,
  type PlaceSnapshot,
} from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { placeDetails } from "@plugins/integrations/plugins/google-maps/plugins/places-api/server";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import { _places } from "./tables";
import {
  isPlaceIdObsolete,
  REFRESH_BATCH,
  refreshCutoff,
  refreshedColumns,
} from "./refresh";

const log = Log.channel("places-refresh");

/**
 * Monthly: re-fetch Google's details for the Google places (a custom place has
 * none) whose snapshot is older than 30 days, so a place that closed (or was
 * renamed, or changed type) shows it. The oldest
 * `REFRESH_BATCH` first, one call at a time — the bill is bounded per run, and
 * whatever is left is next month's oldest.
 *
 * Main only (the schedule's default): the saved places that matter live in
 * main's DB, and every worktree re-fetching its fork's copy would bill Google
 * once per worktree.
 *
 * A place whose id Google no longer finds (NOT_FOUND — `isPlaceIdObsolete`) is
 * an answer, not a fault: it is marked `googleLostAt` (kept from the first
 * miss), its snapshot left as last fetched, and asked again in 30 days like
 * any other — the card and the "Google link lost" filter show it. A success
 * clears the mark.
 *
 * Any other refusal (`PlacesApiError`) is skipped, keeps its old `fetchedAt`
 * (so next month asks again) and fails the run once the batch is done — loud,
 * without one bad id starving the rest of the batch.
 */
export const refreshPlacesJob = defineJob({
  name: "places.refresh-details",
  description:
    "Re-fetches Google Place Details for saved Google places (not custom ones) older than 30 days, updating Google's name for each (never the user's title), whether it is still open, its Google types and its Maps link — and marking a place whose id Google no longer finds as lost.",
  // Up to REFRESH_BATCH sequential Google calls with no per-call timeout.
  hold: "minutes",
  inProcess:
    "Each place is written as soon as it is fetched, so a restart mid-run loses at most one call: the next run selects only the places still stale.",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "0 4 1 * *" }, // monthly, the 1st at 04:00 UTC; main only
  async run() {
    // Custom places have no Google id: nothing to re-fetch.
    const rows = await db
      .select({ id: _places.id, googlePlaceId: _places.googlePlaceId })
      .from(_places)
      .where(
        and(
          isNotNull(_places.googlePlaceId),
          lt(_places.fetchedAt, refreshCutoff(new Date())),
        ),
      )
      .orderBy(asc(_places.fetchedAt))
      .limit(REFRESH_BATCH);
    const stale = rows.filter(
      (r): r is { id: typeof r.id; googlePlaceId: string } =>
        r.googlePlaceId !== null,
    );
    if (stale.length === 0) {
      log.publish("no place is due a refresh");
      return;
    }

    const maps = await getPlacesClient();
    if (!maps.ok) {
      // Nothing can be refreshed until the user connects a Maps key; retrying
      // cannot change that.
      throw new NonRetryableError(
        `${stale.length} place(s) are due a Google refresh, but Google Maps is not configured`,
      );
    }

    const failed: string[] = [];
    let closed = 0;
    let lost = 0;
    for (const place of stale) {
      let snapshot: PlaceSnapshot;
      try {
        snapshot = await placeDetails(maps.client, place.googlePlaceId);
      } catch (err) {
        if (!(err instanceof PlacesApiError)) throw err;
        if (isPlaceIdObsolete(err)) {
          lost += 1;
          const now = new Date();
          await db
            .update(_places)
            .set({
              googleLostAt: sql`coalesce(${_places.googleLostAt}, ${now})`,
              fetchedAt: now,
            })
            .where(eq(_places.id, place.id));
          continue;
        }
        failed.push(`${place.googlePlaceId} (${err.status}: ${err.message})`);
        continue;
      }
      const columns = refreshedColumns(snapshot);
      if (columns.businessStatus === "CLOSED_PERMANENTLY") closed += 1;
      await db
        .update(_places)
        .set({ ...columns, fetchedAt: new Date() })
        .where(eq(_places.id, place.id));
    }

    log.publish(
      `refreshed ${stale.length - failed.length - lost}/${stale.length} place(s); ${closed} permanently closed; ${lost} no longer found by Google`,
    );
    if (failed.length > 0) {
      throw new NonRetryableError(
        `Google refused ${failed.length} place(s): ${failed.join("; ")}`,
      );
    }
  },
});
