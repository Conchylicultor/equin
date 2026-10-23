import { _songs } from "@plugins/apps/plugins/sonata/plugins/library/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { songChordGridShape } from "../../core";

// This source's persisted data for a song, attached to the library's
// `sonata_songs` row via the entity-extensions primitive (1:1 side-table, FK
// CASCADE on song delete). Owned here so the library schema stays source-agnostic
// and a new source needs zero library changes. Table: `sonata_songs_ext_chord_grid`.
// The column (and its exposure to every list of songs) is declared in
// `songChordGridShape`.
export const songChordGrid = defineExtension(
  _songs,
  "chord_grid",
  songChordGridShape,
);
export const _songChordGridExt = songChordGrid.table; // drizzle-kit discovery
