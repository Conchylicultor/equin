export {
  VideoIdSchema,
  youtubeThumbnailUrl,
  youtubeVideoId,
  youtubeWatchUrl,
} from "./internal/video-id";
export {
  EmbedStatusSchema,
  statusFromOembedCode,
  statusFromPlayerCode,
} from "./internal/embed-status";
export type { CodeVerdict, EmbedStatus } from "./internal/embed-status";
export { snapPlaybackRate } from "./internal/playback-rate";
