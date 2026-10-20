import { describe, expect, it } from "bun:test";
import {
  emptyScore,
  type LyricAnnotation,
  type LyricChord,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  activeLyricChord,
  lyricLines,
  lyricPosition,
  sameActiveChord,
} from "./lyric-lines";

/** A lyric line over `[start, end)` with chords at the given beats. */
function line(
  start: number,
  end: number,
  text: string,
  chords: [string, number][] = [],
): LyricAnnotation {
  return {
    type: "lyric",
    start,
    end,
    data: {
      text,
      chords: chords.map(([symbol, beat], i): LyricChord => ({
        symbol,
        beat,
        charOffset: i * 4,
      })),
    },
    source: "authored",
  };
}

describe("lyricLines", () => {
  it("keeps only lyric annotations, sorted by start", () => {
    const score: Score = {
      ...emptyScore(),
      annotations: [
        line(8, 16, "second"),
        {
          type: "section",
          start: 0,
          end: 16,
          data: { name: "Verse" },
          source: "authored",
        },
        line(0, 8, "first"),
      ],
    };
    expect(lyricLines(score).map((l) => l.data.text)).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("activeLyricChord", () => {
  const lines = [
    line(0, 8, "a", [
      ["C", 0],
      ["G", 4],
    ]),
    line(8, 16, "b", [
      ["Am", 8],
      ["F", 12],
    ]),
  ];

  it("is null before the first chord", () => {
    expect(activeLyricChord(lines, -1)).toBeNull();
  });

  it("is the latest chord at or before the beat", () => {
    expect(activeLyricChord(lines, 0)).toEqual({ line: 0, chord: 0 });
    expect(activeLyricChord(lines, 5)).toEqual({ line: 0, chord: 1 });
    expect(activeLyricChord(lines, 9)).toEqual({ line: 1, chord: 0 });
    expect(activeLyricChord(lines, 99)).toEqual({ line: 1, chord: 1 });
  });

  it("lets a later line win a tie", () => {
    const tied = [line(0, 8, "a", [["C", 8]]), line(8, 16, "b", [["C", 8]])];
    expect(activeLyricChord(tied, 8)).toEqual({ line: 1, chord: 0 });
  });
});

describe("sameActiveChord", () => {
  it("compares by value", () => {
    expect(sameActiveChord({ line: 1, chord: 2 }, { line: 1, chord: 2 })).toBe(
      true,
    );
    expect(sameActiveChord({ line: 1, chord: 2 }, null)).toBe(false);
    expect(sameActiveChord(null, null)).toBe(true);
  });
});

describe("lyricPosition", () => {
  const lines = [
    line(0, 8, "one two", [
      ["C", 0],
      ["G", 4],
    ]),
    line(8, 16, "lead in then", [["Am", 10]]),
  ];
  it("is null before the first line", () => {
    expect(lyricPosition(lines, -1)).toBeNull();
  });
  it("names the piece under the last chord at or before the beat", () => {
    expect(lyricPosition(lines, 5)).toEqual({ line: 0, piece: 1 });
  });
  it("is the lead-in (-1) before a line's first chord", () => {
    // The previous line's G still sounds, but the singing is on line 1.
    expect(lyricPosition(lines, 9)).toEqual({ line: 1, piece: -1 });
    expect(lyricPosition(lines, 10)).toEqual({ line: 1, piece: 0 });
  });
});
