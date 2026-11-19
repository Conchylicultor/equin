import { describe, expect, test } from "bun:test";
import { aboveFloorTable } from "./above-floor";
import { npmSourceName, scanChunk, sourceIndexAt } from "./vendor-scan";

const table = aboveFloorTable();
const scan = (text: string) => scanChunk("chunk.js", text, table);

describe("scanChunk", () => {
  test("reports the flags and syntax above the floor, with their position", () => {
    const { regexes, hits } = scan(
      'var a=/\\p{RGI_Emoji}/v,b=new RegExp("x","v"),c=/(?i:ab)c/,d=/(?<y>a)|(?<y>b)/;',
    );
    expect(regexes).toBe(4);
    expect(hits.map((h) => [h.column, h.regex])).toEqual([
      [7, "/\\p{RGI_Emoji}/v"],
      [26, 'new RegExp("x","v")'],
      [48, "/(?i:ab)c/"],
      [61, "/(?<y>a)|(?<y>b)/"],
    ]);
    expect(hits[0]!.problem).toContain("unicodeSets");
    expect(hits[0]!.problem).toContain("Safari 17");
    expect(hits[2]!.problem).toContain("modifier");
    expect(hits[3]!.problem).toContain("duplicate_named_capturing_groups");
  });

  test("passes regexes the floor has, and a division that is no regex", () => {
    expect(
      scan("var e=x/2/1,f=/ok/gu,g=/(?<n>a)\\k<n>/,h=/(?<=a)b/s;").hits,
    ).toEqual([]);
  });

  test("passes a regex created inside a try (a feature test)", () => {
    expect(
      scan(
        'var La=(()=>{try{new RegExp("(?i:)")}catch{return!1}return!0})(),Pa=(()=>{try{new RegExp("","v")}catch{return!1}return!0})();',
      ).hits,
    ).toEqual([]);
  });

  test("passes a flag behind a test of its member, not one tested elsewhere", () => {
    const { hits } = scan(
      'var ok="unicodeSets" in RegExp.prototype?new RegExp("x","v"):/x/u;if(hasV){var bad=new RegExp("y","v")}',
    );
    expect(hits.map((h) => h.regex)).toEqual(['new RegExp("y","v")']);
  });

  test("checks a computed source's literal flags", () => {
    expect(scan('new RegExp(src,"v")').hits).toHaveLength(1);
    expect(scan("new RegExp(src,flags)").hits).toEqual([]);
  });
});

describe("sourceIndexAt", () => {
  // Line 1: col 0 → source 0; col 10 → source 1. Line 2: col 4 → source 1
  // (the source delta runs on across lines); col 8 → no source.
  const mappings = "AAAA,UCAA;IAAA,I";

  test("finds the segment at or before the column, 1-based", () => {
    expect(sourceIndexAt(mappings, 1, 1)).toBe(0);
    expect(sourceIndexAt(mappings, 1, 10)).toBe(0);
    expect(sourceIndexAt(mappings, 1, 11)).toBe(1);
    expect(sourceIndexAt(mappings, 2, 5)).toBe(1);
  });

  test("answers -1 before the first segment and in an unmapped segment", () => {
    expect(sourceIndexAt(mappings, 2, 1)).toBe(-1);
    expect(sourceIndexAt(mappings, 2, 9)).toBe(-1);
    expect(sourceIndexAt(mappings, 3, 1)).toBe(-1);
  });
});

test("npmSourceName names the file from its last node_modules on", () => {
  expect(
    npmSourceName(
      "../../node_modules/.bun/oniguruma-to-es@4.3.6/node_modules/oniguruma-to-es/src/utils.js",
    ),
  ).toBe("node_modules/oniguruma-to-es/src/utils.js");
  expect(npmSourceName("src/x.js")).toBe("src/x.js");
});
