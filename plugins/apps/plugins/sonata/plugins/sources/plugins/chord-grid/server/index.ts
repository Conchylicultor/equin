import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import {
  createChordGridSong,
  getSongChordGrid,
  updateChordGridSong,
} from "../shared/endpoints";
import {
  handleCreateChordGridSong,
  handleGetSongChordGrid,
  handleUpdateChordGridSong,
} from "./internal/routes";
import { songChordGrid } from "./internal/tables";

export { songChordGrid } from "./internal/tables";

export default {
  description:
    "Owns the sonata_songs_ext_chord_grid side-table: per-song chord text. Creates chord-grid–backed songs, persists grid edits (syncing the parent song's derived duration only; the title is library-owned), and exposes the chord text to every list of songs (LiveColumns.Expose) for its Chords field and cover.",
  httpRoutes: {
    [createChordGridSong.route]: handleCreateChordGridSong,
    [getSongChordGrid.route]: handleGetSongChordGrid,
    [updateChordGridSong.route]: handleUpdateChordGridSong,
  },
  contributions: [LiveColumns.Expose(songChordGrid)],
} satisfies ServerPluginDefinition;
