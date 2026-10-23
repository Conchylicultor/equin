import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { songsEntityRef } from "@plugins/apps/plugins/sonata/plugins/library/core";

/**
 * One song's persisted chord grid, stored in the `sonata_songs_ext_chord_grid`
 * entity-extension table owned by this source plugin (1:1 with `sonata_songs`,
 * FK CASCADE on song delete), which `server/internal/tables.ts` builds from
 * this shape. Voicing is not per-song — the shell's reactive re-voicing step
 * owns chord notes under a single global voicing config — so the grid persists
 * chord text only.
 *
 * `chordText` is EXPOSED to every list of songs (the library) as its Chords
 * field: the card / table cell (the first chords, `web/internal/presentation`)
 * and the chord-grid cover (`web/components/chord-grid-cover`) both read it off
 * the row. No default, so a song with no grid (no extension row) reads null.
 * The editor still loads the grid through `getSongChordGrid`.
 */
export const songChordGridShape = defineExtensionShape({
  key: "songId",
  fields: { chordText: textField() },
  exposes: {
    parent: songsEntityRef,
    name: "chord_grid",
    fields: { chordText: { label: "Chords" } },
  },
});
