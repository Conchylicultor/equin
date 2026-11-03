import { describe, expect, it } from "bun:test";
import { dateAwareReplaceEqualDeep } from "./structural-sharing";

describe("dateAwareReplaceEqualDeep", () => {
  it("returns the previous value when deeply equal, equal Dates included", () => {
    const prev = [{ id: "a", at: new Date(1) }];
    const next = [{ id: "a", at: new Date(1) }];
    expect(dateAwareReplaceEqualDeep(prev, next)).toBe(prev);
  });

  it("keeps an unchanged row and copies a changed one", () => {
    const a = { id: "a", v: 1 };
    const b = { id: "b", v: 1 };
    const out = dateAwareReplaceEqualDeep(
      [a, b],
      [
        { id: "a", v: 1 },
        { id: "b", v: 2 },
      ],
    ) as unknown[];
    expect(out[0]).toBe(a);
    expect(out[1]).toEqual({ id: "b", v: 2 });
  });

  it("keeps a moved element the previous array held, by reference", () => {
    const a = { id: "a", v: 1 };
    const b = { id: "b", v: 2 };
    const c = { id: "c", v: 3 };
    const prev = [a, b, c];
    const out = dateAwareReplaceEqualDeep(prev, [b, a, c]) as unknown[];
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(b);
    expect(out[1]).toBe(a);
    expect(out[2]).toBe(c);
  });

  it("still prefers the positional match when it is deeply equal", () => {
    const x = { v: 1 };
    const y = { v: 1 };
    const prev = [x, y];
    // Swapped references, equal values: the positional default's answer (the
    // previous array) is kept — never weaker than positional sharing.
    expect(dateAwareReplaceEqualDeep(prev, [y, x])).toBe(prev);
  });

  it("keeps a moved element inside a nested array", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const prev = { rows: [a, b], n: 1 };
    const out = dateAwareReplaceEqualDeep(prev, {
      rows: [b, a],
      n: 2,
    }) as typeof prev;
    expect(out.rows[0]).toBe(b);
    expect(out.rows[1]).toBe(a);
  });
});
