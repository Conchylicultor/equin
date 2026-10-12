import { describe, expect, it } from "bun:test";
import { MAJOR_SCALE, rootReading } from "./degree";

describe("rootReading", () => {
  it("reads each major-scale degree bare", () => {
    expect(MAJOR_SCALE.map((pc) => rootReading(pc, 0))).toEqual(
      ([0, 1, 2, 3, 4, 5, 6] as const).map((degree) => ({
        degree,
        accidental: 0 as const,
      })),
    );
  });

  it("reads a chromatic root as its conventional numeral's number", () => {
    // ♭II ♭III ♯IV ♭VI ♭VII
    expect([1, 3, 6, 8, 10].map((pc) => rootReading(pc, 0))).toEqual([
      { degree: 1, accidental: -1 },
      { degree: 2, accidental: -1 },
      { degree: 3, accidental: 1 },
      { degree: 5, accidental: -1 },
      { degree: 6, accidental: -1 },
    ]);
  });

  it("reads a minor key against the major scale too", () => {
    // B minor (tonic 11): D is ♭III, G ♭VI, A ♭VII.
    expect(rootReading(2, 11)).toEqual({ degree: 2, accidental: -1 });
    expect(rootReading(7, 11)).toEqual({ degree: 5, accidental: -1 });
    expect(rootReading(9, 11)).toEqual({ degree: 6, accidental: -1 });
  });

  it("transposes with the tonic and reads pitch classes mod 12", () => {
    // In G (tonic 7): D is V, F is ♭VII.
    expect(rootReading(2, 7)).toEqual({ degree: 4, accidental: 0 });
    expect(rootReading(5, 7)).toEqual({ degree: 6, accidental: -1 });
    expect(rootReading(14, 0)).toEqual({ degree: 1, accidental: 0 });
    expect(rootReading(-1, 0)).toEqual({ degree: 6, accidental: 0 });
  });
});
