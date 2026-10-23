/**
 * The alignment fact every list of songs derives from the alignment exposure:
 * the recording's `videoId`, labelled "Video", which a song with no alignment
 * row (or no video yet) reads as null.
 */

import { describe, expect, test } from "bun:test";
import { ugAlignmentShape } from "./row";

describe("UG alignment exposure", () => {
  test("exposes only videoId on the songs entity, nullable when absent", () => {
    const { exposure } = ugAlignmentShape;
    expect(exposure.parent.name).toBe("sonata_songs");
    expect(exposure.slice).toBe("sonata_songs_ext_ug_alignment");
    expect(Object.values(exposure.fields).map((f) => f.id)).toEqual([
      "videoId",
    ]);
    expect(exposure.fields.videoId).toMatchObject({
      label: "Video",
      typeId: "text",
      absent: null,
    });
    expect(exposure.row.parse({ videoId: null })).toEqual({ videoId: null });
  });
});
