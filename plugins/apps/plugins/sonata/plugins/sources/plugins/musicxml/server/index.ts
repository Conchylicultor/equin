import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import { createMusicXmlSong, getSongMusicXmlCover } from "../shared/endpoints";
import { handleMusicXmlCover } from "./internal/cover";
import { handleCreateMusicXmlSong } from "./internal/routes";
import { songMusicXmlRowsServed } from "./internal/resources";

export { importMusicXmlForSong } from "./internal/import";
export type { ImportMusicXmlForSongInput } from "./internal/import";
export { MusicXmlParseError } from "../shared/parse";
export { MUSICXML_SOURCE_ID } from "../shared/constants";

export default {
  description:
    "Owns the sonata_songs_ext_musicxml side-table: per-song MusicXML attachment + content hash. Creates MusicXML-backed songs from an uploaded document (content-hash dedup), serves each song's row as the lookup-only live collection sonata.musicxml (what the player hydrates the song from) and fills an existing MusicXML song with a document (importMusicXmlForSong, for the transcription flow). Serves each song's staff cover (GET …/musicxml/cover/<version>.svg, drawn by covers).",
  contributions: [...songMusicXmlRowsServed.declare],
  httpRoutes: {
    [createMusicXmlSong.route]: handleCreateMusicXmlSong,
    [getSongMusicXmlCover.route]: rawEndpointHandler(
      getSongMusicXmlCover,
      handleMusicXmlCover,
    ),
  },
} satisfies ServerPluginDefinition;
