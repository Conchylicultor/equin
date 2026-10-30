import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

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
});

/** Reset a song to defaults by deleting all its persisted track overrides. */
export const resetTrackView = defineEndpoint({
  route: "DELETE /api/sonata/songs/:songId/track-view",
});
