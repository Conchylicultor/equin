import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromChangeFeed } from "@plugins/network/plugins/live/plugins/change-feed/server";
import { View } from "@plugins/database/plugins/derived-views/server";
import { reportPlaybackEndpoint, videoStatusSummaryEndpoint } from "../core";
import {
  handleReportPlayback,
  handleVideoStatusSummary,
} from "./internal/handlers";
import { _chordVideos } from "./internal/tables";
import { chordVideoStatus } from "./internal/views";

export { _chordVideos } from "./internal/tables";
export { chordVideoStatus } from "./internal/views";
export { ensureVideoStatus } from "./internal/check";

export default {
  description:
    "Chord video availability: the chord_videos evidence ledger (oEmbed's answer and the player's, each in its own columns), the chord_video_status_v view that resolves them, the on-demand oEmbed check a loop query runs over the videos it is about to offer, and the player's playback-report endpoint.",
  httpRoutes: {
    [reportPlaybackEndpoint.route]: handleReportPlayback,
    [videoStatusSummaryEndpoint.route]: handleVideoStatusSummary,
  },
  contributions: [
    View({ view: chordVideoStatus }),
    // Kept in forks and backups on purpose (no ExcludeFromFork /
    // ExcludeFromBackup): ~13k tiny rows at most, holding the player's reports,
    // which nothing can recover, and copying them spares every worktree the
    // re-checks. No growth bound either: rows are minted only for videos a loop
    // query offered, which the dump bounds at ~12.7k.
    ExcludeFromChangeFeed({
      table: _chordVideos,
      reason:
        "No live-state resource reads video availability: the loop query reads it per call. Remove this exclusion if a live surface ever does.",
    }),
  ],
} satisfies ServerPluginDefinition;
