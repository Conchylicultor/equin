import { describe, expect, it } from "bun:test";
import { gridLines, gridPad, phaseBase } from "./grid-phase";

const keys = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => `k${from + i}`);
const indexOf = (ks: string[], base: number) =>
  new Map(ks.map((k, i) => [k, base + i]));

describe("grid phase", () => {
  it("places a band by the first key the previous layout knows", () => {
    const prev = indexOf(keys(0, 100), 0);
    // Head page released: the first survivor was drawn at 50.
    expect(phaseBase(prev, keys(50, 100))).toBe(50);
    // Its first key is new (a page landing above it): the next known one places it.
    expect(phaseBase(prev, ["new", ...keys(50, 100)])).toBe(49);
    // A jump: nothing known.
    expect(phaseBase(prev, keys(200, 210))).toBe(0);
  });

  it("pads by the phase modulo the column count", () => {
    expect(gridPad(50, 4)).toBe(2);
    expect(gridPad(48, 4)).toBe(0);
    expect(gridPad(-1, 4)).toBe(3);
    expect(gridPad(7, 0)).toBe(0);
  });

  it("keys lines by absolute line, so a head release keeps every surviving line's key", () => {
    const all = gridLines(keys(0, 100), 4, 0);
    const released = gridLines(keys(50, 100), 4, 50);
    // The released band's first line is the mid-line one: two spacers, then 50, 51.
    expect(released[0]).toEqual({
      key: "line:12@4",
      cells: [null, null, "k50", "k51"],
    });
    for (const line of released.slice(1)) {
      expect(all.find((l) => l.key === line.key)?.cells).toEqual(line.cells);
    }
    // Another column count is another set of lines.
    expect(gridLines(keys(0, 3), 3, 0)[0]!.key).toBe("line:0@3");
  });
});
