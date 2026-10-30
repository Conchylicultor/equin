import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * Set the song's recording from a pasted YouTube link (or a bare id) and start
 * aligning to it: the user's pick (`pick: "user"`), which nothing automatic
 * overrides. Picking one of the resolver's candidates is this call with its id.
 * 400 when the text is not a YouTube video.
 */
export const setUgAlignmentVideo = defineEndpoint({
  route: "PUT /api/sonata/songs/:id/ultimate-guitar/alignment/video",
  body: z.object({ url: z.string() }),
  response: z.object({ videoId: z.string() }),
});

/**
 * Align the song again ("Retry", or on demand): to its current video, or — with
 * no video and the resolver owning the choice — go on with the candidate walk
 * from the next untried candidate (after a failure, a cancel, or a needs-video).
 * 409 when there is nothing to align to.
 */
export const realignUg = defineEndpoint({
  route: "POST /api/sonata/songs/:id/ultimate-guitar/alignment/realign",
  response: z.object({ ok: z.literal(true) }),
});

/**
 * Stop the song's alignment (`queued`, `resolving` or `running`): the row
 * becomes `cancelled`, a candidate being tried goes back to untried, and the
 * running job is stopped and recorded as cancelled (no retry, no report).
 * Nothing restarts it until the user retries (`realignUg`) or sets a video.
 * 409 when nothing is in progress.
 */
export const cancelUgAlignment = defineEndpoint({
  route: "POST /api/sonata/songs/:id/ultimate-guitar/alignment/cancel",
  response: z.object({ ok: z.literal(true) }),
});

/**
 * Find a video for the song automatically ("Find a video"): forget the current
 * video and candidates, search again, and align the best candidates in turn
 * until one aligns well enough (`pick: "auto"`).
 */
export const resolveUgAlignment = defineEndpoint({
  route: "POST /api/sonata/songs/:id/ultimate-guitar/alignment/resolve",
  response: z.object({ ok: z.literal(true) }),
});

/**
 * The embedded player refused this video: `not-embeddable` (IFrame error
 * 101 / 150) marks the candidate `not-embeddable`, `gone` (removed or private)
 * marks it `failed`; when the resolver picked it, the pick moves on to the next
 * candidate. Idempotent — the same refusal again changes nothing. `resolving`
 * says whether a new pick was started.
 */
export const refuseUgAlignmentVideo = defineEndpoint({
  route: "POST /api/sonata/songs/:id/ultimate-guitar/alignment/video-refused",
  body: z.object({
    videoId: z.string(),
    status: z.enum(["gone", "not-embeddable"]),
  }),
  response: z.object({ resolving: z.boolean() }),
});
