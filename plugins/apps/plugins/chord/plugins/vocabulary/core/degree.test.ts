import { describe, expect, it } from "bun:test";
import { ChordTokenSchema } from "@plugins/apps/plugins/chord/plugins/song-index/core";
import type { ScaleDegree } from "@plugins/music/plugins/chord-box/core";
import { chordDegree, chordFunction, type ChordFunction } from "./degree";

const token = (text: string) => ChordTokenSchema.parse(text);

describe("chord degree and function", () => {
  const cases: [string, ScaleDegree, ChordFunction][] = [
    ["0:4-3/0", 0, "tonic"],
    ["2:3-4/0", 1, "subdominant"],
    ["4:3-4/0", 2, "tonic"],
    ["5:4-3/1", 3, "subdominant"],
    ["7:4-3-3/0", 4, "dominant"],
    ["9:3-4/0", 5, "tonic"],
    ["11:3-3/0", 6, "dominant"],
  ];
  for (const [text, degree, fn] of cases) {
    it(`${text}: degree ${degree}, ${fn}`, () => {
      expect(chordDegree(token(text))).toBe(degree);
      expect(chordFunction(token(text))).toBe(fn);
    });
  }

  it("reads a chromatic root as its numeral's number, with no function", () => {
    const cases: [string, ScaleDegree][] = [
      ["10:4-3/0", 6], // ♭VII
      ["3:4-3/0", 2], // ♭III
      ["1:4-3/0", 1], // ♭II
      ["6:3-3/0", 3], // ♯iv°
      ["8:4-3/0", 5], // ♭VI
    ];
    for (const [text, degree] of cases) {
      expect(chordDegree(token(text))).toBe(degree);
      expect(chordFunction(token(text))).toBeNull();
    }
  });
});
