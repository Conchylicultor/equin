import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { VideoStatusSchema } from "./status";

// ── The video-availability HTTP surface ──────────────────────────────────────

/**
 * What the player saw when it tried a video. `code` is the IFrame API's
 * `onError` code, mapped by `statusFromPlayerCode` (`integrations/youtube/core`).
 */
export const PlaybackReportSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("playing") }),
  z.object({ outcome: z.literal("error"), code: z.number().int() }),
]);
export type PlaybackReport = z.infer<typeof PlaybackReportSchema>;

/**
 * Record what the player saw. It writes only the player's own evidence, and
 * that wins over oEmbed's (except oEmbed's `gone`): the player sees region
 * blocks and sites that refuse playback, which oEmbed cannot. Answers the
 * video's status after the report, as the view resolves it.
 */
export const reportPlaybackEndpoint = defineEndpoint({
  route: "POST /api/chord/videos/:videoId/playback",
  body: PlaybackReportSchema,
  response: z.object({ status: VideoStatusSchema }),
});

/** A count per status. Every key present, zero included. */
export const VideoStatusCountsSchema = z.object({
  unknown: z.number().int(),
  ok: z.number().int(),
  gone: z.number().int(),
  "not-embeddable": z.number().int(),
});
export type VideoStatusCounts = z.infer<typeof VideoStatusCountsSchema>;

/**
 * How the videos anyone has looked at resolve today. Only the videos a loop
 * query offered have a row — nothing sweeps the corpus — so this is a picture
 * of what the trainer has touched, not of the whole index.
 */
export const videoStatusSummaryEndpoint = defineEndpoint({
  route: "GET /api/chord/videos/summary",
  response: z.object({
    videos: z.number().int(),
    byStatus: VideoStatusCountsSchema,
  }),
});
