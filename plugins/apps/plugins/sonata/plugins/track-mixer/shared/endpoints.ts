import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { patchValue } from "@plugins/network/plugins/live/core";
import { trackViews } from "./resources";

/**
 * Partial-patch upsert of one or more tracks' view overrides — the SAME patch
 * applied to every `trackIds` entry, in one transaction. Only the provided fields
 * are written; omitted fields keep their prior value (or the column default on
 * first insert). `color: null` explicitly clears a custom color back to the
 * palette default; `instrument: null` clears the override back to "auto". A
 * single-track edit passes `[trackId]`; a whole-arrangement flip (chord mode
 * deactivating every original track) passes them all, so the change lands as one
 * commit and one live-state push rather than a per-track flicker.
 *
 * `volume` is the fader position as a linear gain multiplier — 1 is unity, 0 is
 * silent, 2 is +6 dB — which is why the range is validated here rather than left
 * open: the number goes straight into a Web Audio `GainNode`, so an out-of-range
 * value would be a real (and loud) bug rather than a display glitch. It is not
 * nullable: there is no "no opinion" fader position, only unity.
 */
export const upsertTrackView = defineEndpoint({
  route: "POST /api/sonata/songs/:songId/track-view",
  body: z.object({
    trackIds: z.array(z.string()).min(1),
    color: z.string().nullable().optional(),
    instrument: z.string().nullable().optional(),
    muted: z.boolean().optional(),
    hidden: z.boolean().optional(),
    volume: z.number().min(0).max(2).optional(),
  }),
  // The song's overrides are ONE value tuple `{ songId }`, so the write rides
  // that tuple's send lane — the SAME lane as a reset, last writer wins in the
  // order issued — and needs no named lane. Mirrors the server: a fresh row
  // takes the column defaults, an existing one only the provided columns.
  effect: (on) =>
    patchValue(
      on,
      trackViews,
      ({ params }) => ({ songId: params.songId }),
      (rows, { params, body }) => {
        const patch = {
          ...(body.color === undefined ? {} : { color: body.color }),
          ...(body.instrument === undefined
            ? {}
            : { instrument: body.instrument }),
          ...(body.muted === undefined ? {} : { muted: body.muted }),
          ...(body.hidden === undefined ? {} : { hidden: body.hidden }),
          ...(body.volume === undefined ? {} : { volume: body.volume }),
        };
        const wanted = new Set(body.trackIds);
        const next = rows.map((r) =>
          wanted.has(r.trackId) ? { ...r, ...patch } : r,
        );
        const have = new Set(rows.map((r) => r.trackId));
        for (const trackId of new Set(body.trackIds)) {
          if (have.has(trackId)) continue;
          next.push({
            songId: params.songId as (typeof rows)[number]["songId"],
            trackId,
            color: null,
            instrument: null,
            muted: false,
            hidden: false,
            volume: 1,
            ...patch,
          });
        }
        return next;
      },
    ),
});

/** Reset a song to defaults by deleting all its persisted track overrides. */
export const resetTrackView = defineEndpoint({
  route: "DELETE /api/sonata/songs/:songId/track-view",
  // Deletes every row of the song: its one value tuple becomes empty.
  effect: (on) =>
    patchValue(
      on,
      trackViews,
      ({ params }) => ({ songId: params.songId }),
      () => [],
    ),
});
