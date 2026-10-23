/**
 * The chord-grid fact every list of songs derives from the chord-grid
 * exposure: `chordText`, labelled "Chords", reading null for a song with no
 * grid row.
 *
 * Run: `./singularity test plugins/apps/plugins/sonata/plugins/sources/plugins/chord-grid`.
 */

import { describe, expect, test } from "bun:test";
import { songChordGridShape } from "./shape";

describe("chord-grid exposure", () => {
  test("exposes chordText on the songs entity as Chords, null when absent", () => {
    const { exposure } = songChordGridShape;
    expect(exposure.parent.name).toBe("sonata_songs");
    expect(exposure.slice).toBe("sonata_songs_ext_chord_grid");
    expect(Object.values(exposure.fields).map((f) => f.id)).toEqual([
      "chordText",
    ]);
    expect(exposure.fields.chordText).toMatchObject({
      label: "Chords",
      absent: null,
    });
  });
});
