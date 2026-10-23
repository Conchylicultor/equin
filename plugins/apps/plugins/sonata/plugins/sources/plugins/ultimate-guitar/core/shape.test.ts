/**
 * The Ultimate Guitar fact every list of songs derives from the UG exposure:
 * the tab's `key`, labelled "Key", which a song with no UG row (or a tab with
 * no key) reads as null.
 *
 * Run: `./singularity test plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar`.
 */

import { describe, expect, test } from "bun:test";
import { ultimateGuitarShape } from "./shape";

describe("Ultimate Guitar exposure", () => {
  test("exposes only key on the songs entity, nullable when absent", () => {
    const { exposure } = ultimateGuitarShape;
    expect(exposure.parent.name).toBe("sonata_songs");
    expect(exposure.slice).toBe("sonata_songs_ext_ultimate_guitar");
    expect(Object.values(exposure.fields).map((f) => f.id)).toEqual(["key"]);
    expect(exposure.fields.key).toMatchObject({
      label: "Key",
      typeId: "text",
      absent: null,
    });
    expect(exposure.row.parse({ key: null })).toEqual({ key: null });
    expect(exposure.row.parse({ key: "C" })).toEqual({ key: "C" });
  });
});
