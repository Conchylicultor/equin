import { describe, expect, it } from "bun:test";
import type { KeyEntry } from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  changeAt,
  keyAt,
  keyChanges,
  longKeyName,
  shortKeyName,
} from "./key-names";

const entry = (
  beat: number,
  tonic: string,
  mode: "major" | "minor",
): KeyEntry => ({ beat, key: { tonic, mode }, source: "authored" });

const SONG = [
  entry(0, "B", "major"),
  entry(32, "G#", "minor"),
  entry(64, "Eb", "major"),
];

describe("key names", () => {
  it("shortens with glyph accidentals and an m for minor", () => {
    expect(shortKeyName({ tonic: "B", mode: "major" })).toBe("B");
    expect(shortKeyName({ tonic: "G#", mode: "minor" })).toBe("G♯m");
    expect(shortKeyName({ tonic: "Bb", mode: "major" })).toBe("B♭");
  });

  it("spells out the mode in the long form", () => {
    expect(longKeyName({ tonic: "B", mode: "major" })).toBe("B major");
    expect(longKeyName({ tonic: "G#", mode: "minor" })).toBe("G♯ minor");
    expect(longKeyName({ tonic: "B♭", mode: "minor" })).toBe("B♭ minor");
  });
});

describe("keyChanges", () => {
  it("drops the starting entry", () => {
    expect(keyChanges(SONG).map((e) => e.beat)).toEqual([32, 64]);
  });

  it("treats a delayed first key as the start, not a change", () => {
    expect(keyChanges([entry(8, "C", "major")])).toEqual([]);
  });
});

describe("keyAt", () => {
  it("is the latest entry at or before the beat", () => {
    expect(keyAt(SONG, 0)?.tonic).toBe("B");
    expect(keyAt(SONG, 31.9)?.tonic).toBe("B");
    expect(keyAt(SONG, 32)?.tonic).toBe("G#");
    expect(keyAt(SONG, 100)?.tonic).toBe("Eb");
  });

  it("falls back to the starting key before the first entry", () => {
    expect(keyAt([entry(8, "C", "major")], -2)?.tonic).toBe("C");
  });

  it("is undefined for a keyless song", () => {
    expect(keyAt([], 4)).toBeUndefined();
  });
});

describe("changeAt", () => {
  it("finds a change only exactly on its beat", () => {
    expect(changeAt(SONG, 32)?.key.tonic).toBe("G#");
    expect(changeAt(SONG, 33)).toBeUndefined();
  });

  it("never reports the starting key as a change", () => {
    expect(changeAt(SONG, 0)).toBeUndefined();
  });
});
