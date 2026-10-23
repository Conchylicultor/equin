import { exposedColumns } from "@plugins/network/plugins/live/core";
import { Library } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { songChordGridShape } from "../../core";
import { CHORD_GRID_SOURCE_ID } from "../constants";
import { ChordGridCover } from "../components/chord-grid-cover";
import { coverChords } from "./cover-chords";

// The grid text every song row carries, folded in from the chord-grid
// exposure (`$columns.sonata_songs_ext_chord_grid`).
const chordGrid = exposedColumns(songChordGridShape.exposure);

/**
 * The chord-grid source's answer to "what is this song's cover?": its first
 * chords as tiles in their degree colours (`ChordGridCover`). A hook-free read
 * of the row — the grid text it carries — so it answers per card per render.
 * A song of another source, or a grid with no chord in it yet, gets no answer
 * (the library's quiet base cover shows).
 */
export const chordGridCover = Library.Cover({
  id: CHORD_GRID_SOURCE_ID,
  cover: (song) => {
    if (song.source !== CHORD_GRID_SOURCE_ID) return undefined;
    const { chordText } = chordGrid.read(song);
    if (chordText === null) return undefined;
    const chords = coverChords(chordText);
    if (chords.length === 0) return undefined;
    return {
      kind: "art",
      content: { kind: "node", node: <ChordGridCover chords={chords} /> },
    };
  },
});
