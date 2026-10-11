import { describe, expect, it } from "bun:test";
import { scaleDegree } from "./degree";

describe("scaleDegree", () => {
  it("reads each major-scale degree off the root, relative to the tonic", () => {
    expect(
      [0, 2, 4, 5, 7, 9, 11].map((pc) => scaleDegree(pc, 0, "major")),
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("reads a minor key's degrees off the natural minor", () => {
    expect(
      [0, 2, 3, 5, 7, 8, 10].map((pc) => scaleDegree(pc, 0, "minor")),
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // In B minor (tonic 11): D is III, G is VI, A is VII.
    expect(scaleDegree(2, 11, "minor")).toBe(2);
    expect(scaleDegree(7, 11, "minor")).toBe(5);
    expect(scaleDegree(9, 11, "minor")).toBe(6);
  });

  it("transposes with the tonic", () => {
    // In G (tonic 7): D is V, C is IV, F♯ is vii.
    expect(scaleDegree(2, 7, "major")).toBe(4);
    expect(scaleDegree(0, 7, "major")).toBe(3);
    expect(scaleDegree(6, 7, "major")).toBe(6);
  });

  it("reads pitch classes mod 12", () => {
    expect(scaleDegree(14, 0, "major")).toBe(1);
    expect(scaleDegree(-1, 0, "major")).toBe(6);
    expect(scaleDegree(0, 12, "minor")).toBe(0);
  });

  it("has none for a root outside the scale", () => {
    for (const pc of [1, 3, 6, 8, 10])
      expect(scaleDegree(pc, 0, "major")).toBeNull();
    for (const pc of [1, 4, 6, 9, 11])
      expect(scaleDegree(pc, 0, "minor")).toBeNull();
    // ♭VII in G is F.
    expect(scaleDegree(5, 7, "major")).toBeNull();
  });
});
