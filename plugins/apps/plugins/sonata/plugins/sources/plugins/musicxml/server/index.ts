import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { createMusicXmlSong, getSongMusicXml } from "../shared/endpoints";
import {
  handleCreateMusicXmlSong,
  handleGetSongMusicXml,
} from "./internal/routes";

export { importMusicXmlForSong } from "./internal/import";
export type { ImportMusicXmlForSongInput } from "./internal/import";
export { MusicXmlParseError } from "../shared/parse";
export { MUSICXML_SOURCE_ID } from "../shared/constants";

export default {
  description:
    "Owns the sonata_songs_ext_musicxml side-table: per-song MusicXML attachment + content hash. Creates MusicXML-backed songs from an uploaded document (content-hash dedup) and fills an existing MusicXML song with a document (importMusicXmlForSong, for the transcription flow).",
  httpRoutes: {
    [createMusicXmlSong.route]: handleCreateMusicXmlSong,
    [getSongMusicXml.route]: handleGetSongMusicXml,
  },
} satisfies ServerPluginDefinition;
