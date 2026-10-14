import { _songs } from "@plugins/apps/plugins/sonata/plugins/library/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { songTranscriptionShape } from "../../shared/shape";

// A transcribed song's run state, attached to the library's `sonata_songs` row
// via the entity-extensions primitive (1:1 side-table, FK CASCADE on song
// delete). Table: `sonata_songs_ext_transcription`. The columns are declared
// (and commented) in `songTranscriptionShape`.
export const songTranscription = defineExtension(
  _songs,
  "transcription",
  songTranscriptionShape,
);
export const _songTranscriptionExt = songTranscription.table; // drizzle-kit discovery
