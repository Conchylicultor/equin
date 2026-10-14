/**
 * The MIDI facts every list of songs derives from the MIDI exposure: the ids
 * the library's saved views name are unchanged, a song with no MIDI row reads
 * `trackCount` null and `sourceMissing` false (its declared default), and the
 * server-only content hash is never exposed.
 *
 * Run: `./singularity test plugins/apps/plugins/sonata/plugins/sources/plugins/midi`.
 */

import { describe, expect, test } from "bun:test";
import { songMidiShape } from "./shape";

describe("MIDI exposure", () => {
  test("exposes trackCount and sourceMissing on the songs entity, under their persisted ids", () => {
    const { exposure } = songMidiShape;
    expect(exposure.parent.name).toBe("sonata_songs");
    expect(exposure.slice).toBe("sonata_songs_ext_midi");
    expect(Object.values(exposure.fields).map((f) => f.id)).toEqual([
      "trackCount",
      "sourceMissing",
    ]);
    expect(exposure.fields.trackCount).toMatchObject({
      label: "Tracks",
      absent: null,
    });
    expect(exposure.fields.sourceMissing).toMatchObject({
      label: "File",
      absent: false,
    });
  });
});
