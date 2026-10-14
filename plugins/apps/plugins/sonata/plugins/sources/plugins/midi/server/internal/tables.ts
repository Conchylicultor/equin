import { _songs } from "@plugins/apps/plugins/sonata/plugins/library/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { songMidiShape } from "../../core";

// This source's persisted data for a song, attached to the library's
// `sonata_songs` row via the entity-extensions primitive (1:1 side-table, FK
// CASCADE on song delete). Owned here so the library schema stays source-agnostic
// and a new source needs zero library changes. Table: `sonata_songs_ext_midi`.
// The columns are declared (and commented) in `songMidiShape`.
export const songMidi = defineExtension(_songs, "midi", songMidiShape, {
  columns: { sourceMissing: { default: false } },
  // A backfilled derived hash of the same bytes, not a change to the song's MIDI.
  touchedBy: { contentHash: false },
});
export const _songMidiExt = songMidi.table; // drizzle-kit discovery
