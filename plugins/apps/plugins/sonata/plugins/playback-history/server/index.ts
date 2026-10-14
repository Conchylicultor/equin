import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import { recordPlay } from "../shared/endpoints";
import { handleRecordPlay } from "./internal/routes";
import { songPlayback } from "./internal/tables";

export { songPlayback } from "./internal/tables";

export default {
  description:
    "Owns the sonata_songs_ext_playback side-table: per-song play count + last-played. Records a play on playback start and exposes both to every list of songs (LiveColumns.Expose).",
  httpRoutes: {
    [recordPlay.route]: handleRecordPlay,
  },
  contributions: [LiveColumns.Expose(songPlayback)],
} satisfies ServerPluginDefinition;
