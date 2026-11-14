import { describe, expect, test } from "bun:test";
import { barsDue } from "./look-ahead";

describe("barsDue", () => {
  test("writes every bar starting inside the window, then stops", () => {
    const r = barsDue(0.1, 0, 0, 1.5, () => 0.5);
    expect(r.due).toEqual([
      { at: 0.1, bar: 0 },
      { at: 0.6, bar: 1 },
      { at: 1.1, bar: 2 },
    ]);
    expect(r.next).toBeCloseTo(1.6);
    expect(r.bar).toBe(3);
  });

  test("nothing is due while the next bar is past the window", () => {
    const r = barsDue(3, 4, 1, 1.5, () => 2);
    expect(r.due).toEqual([]);
    expect(r).toMatchObject({ next: 3, bar: 4 });
  });

  test("a lagging position skips to now instead of bursting the missed bars", () => {
    const r = barsDue(1, 2, 10, 1.5, () => 8);
    expect(r.due).toEqual([{ at: 10, bar: 2 }]);
    expect(r).toMatchObject({ next: 18, bar: 3 });
  });

  test("a bar's length is read per bar", () => {
    const r = barsDue(0, 0, 0, 3, (i) => (i % 2 ? 2 : 1));
    expect(r.due.map((d) => d.at)).toEqual([0, 1]);
    expect(r.next).toBe(3);
  });

  test("a non-positive length throws", () => {
    expect(() => barsDue(0, 0, 0, 1, () => 0)).toThrow(/length 0/);
  });
});
