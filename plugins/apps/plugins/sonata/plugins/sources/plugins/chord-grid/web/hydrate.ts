import { exposedColumns } from "@plugins/network/plugins/live/core";
import { mapRow, useLiveRow } from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import { songLibrary } from "@plugins/apps/plugins/sonata/plugins/library/core";
import type { SourceHydration } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { songChordGridShape } from "../core";
import type { ChordGridRaw } from "./compile";

// The grid text every song row carries, folded in from the chord-grid
// exposure (`$columns.sonata_songs_ext_chord_grid`).
const chordGrid = exposedColumns(songChordGridShape.exposure);

/**
 * Hydrate a song's chord-grid source, live: the grid text its library row
 * carries, as the `ChordGridRaw` for `useLoadDocument` (keyed under
 * `"chord-grid"`). `absent` for a song that carries no chord grid (or no
 * longer exists), so it's skipped in the library's generic collection — and so
 * the chord-grid editor section stays hidden for such songs.
 */
export function useHydration(songId: string): ResourceResult<SourceHydration> {
  return mapRow(useLiveRow(songLibrary, songId), (song): SourceHydration => {
    const chordText = song === null ? null : chordGrid.read(song).chordText;
    if (chordText === null) return { kind: "absent" };
    return { kind: "raw", raw: { text: chordText } satisfies ChordGridRaw };
  });
}
