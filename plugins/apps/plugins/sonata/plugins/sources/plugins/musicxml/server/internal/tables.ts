import { _songs } from "@plugins/apps/plugins/sonata/plugins/library/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { songMusicXmlShape } from "../../shared/shape";

// This source's persisted data for a song, attached to the library's
// `sonata_songs` row via the entity-extensions primitive (1:1 side-table, FK
// CASCADE on song delete). Table: `sonata_songs_ext_musicxml`. The columns are
// declared (and commented) in `songMusicXmlShape`.
export const songMusicXml = defineExtension(
  _songs,
  "musicxml",
  songMusicXmlShape,
);
export const _songMusicXmlExt = songMusicXml.table; // drizzle-kit discovery
