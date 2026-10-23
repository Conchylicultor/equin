import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import {
  createMidiSong,
  getSongMidi,
  getSongMidiCover,
} from "../shared/endpoints";
import { handleCreateMidiSong, handleGetSongMidi } from "./internal/routes";
import { handleMidiCover } from "./internal/cover";
import { songMidi } from "./internal/tables";
import { seedMidiStarters, reconcileSeededStarters } from "./internal/seed";
import { backfillContentHashes } from "./internal/import";

export { songMidi } from "./internal/tables";
export {
  importMidiSong,
  getSongMidiBySourcePath,
  setSourceMissing,
  listFolderImportedSongs,
} from "./internal/import";
export type { ImportMidiSongInput } from "./internal/import";

export default {
  description:
    "Owns the sonata_songs_ext_midi side-table: per-song MIDI attachment + track count. Creates MIDI-backed songs, exposes its track count and file-missing flag to every list of songs (LiveColumns.Expose), serves each song's falling-notes cover (GET …/midi/cover/<version>.svg, drawn by covers), and seeds the bundled public-domain MIDI starters at boot.",
  httpRoutes: {
    [createMidiSong.route]: handleCreateMidiSong,
    [getSongMidi.route]: handleGetSongMidi,
    [getSongMidiCover.route]: rawEndpointHandler(
      getSongMidiCover,
      handleMidiCover,
    ),
  },
  contributions: [LiveColumns.Expose(songMidi)],
  onReady: async () => {
    await seedMidiStarters();
    // Drop managed seed songs no longer in STARTERS (renamed/removed starters).
    // After seeding so newly-added ids are never transiently absent.
    await reconcileSeededStarters();
    await backfillContentHashes();
  },
} satisfies ServerPluginDefinition;
