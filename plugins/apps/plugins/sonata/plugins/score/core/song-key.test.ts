import { describe, expect, it } from "bun:test";
import { emptyScore } from "./helpers";
import { songKey } from "./key-context";
import type { Annotation, KeySignature, Score } from "./types";

const key = (
  tonic: string,
  mode: KeySignature["mode"],
  start: number,
  end: number,
): Annotation => ({
  type: "key",
  start,
  end,
  source: "derived",
  data: { tonic, mode },
});

const withKeys = (keys: Annotation[], meta: Score["meta"] = {}): Score => ({
  ...emptyScore(),
  meta,
  annotations: keys,
});

describe("songKey", () => {
  it("is undefined for a keyless score", () => {
    expect(songKey(emptyScore())).toBeUndefined();
  });

  it("is the authored starting key when nothing changes it", () => {
    const score = withKeys([], { key: { tonic: "Eb", mode: "major" } });
    expect(songKey(score)).toMatchObject({
      beat: 0,
      key: { tonic: "Eb", mode: "major" },
      source: "authored",
    });
  });

  it("is the key in force over the most beats, not the first", () => {
    const score = withKeys([
      key("B", "minor", 0, 16),
      key("D", "major", 16, 100),
    ]);
    expect(songKey(score)?.key).toEqual({ tonic: "D", mode: "major" });
  });

  it("adds up a key's stretches when it returns, naming its first entry", () => {
    // F# minor's one 50-beat stretch is longer than either D stretch (30 + 30),
    // but D is in force for 60 beats in all.
    const score = withKeys([
      key("D", "major", 0, 30),
      key("F#", "minor", 30, 80),
      key("D", "major", 80, 110),
    ]);
    expect(songKey(score)).toMatchObject({
      beat: 0,
      key: { tonic: "D", mode: "major" },
    });
  });

  it("breaks a tie toward the key heard first", () => {
    const score = withKeys([key("C", "major", 0, 8), key("G", "major", 8, 16)]);
    expect(songKey(score)?.key).toEqual({ tonic: "C", mode: "major" });
  });
});
