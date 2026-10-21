import { describe, expect, test } from "bun:test";
import { applyValuePatch, diffValue } from "./value-patch";

const roundTrip = (prev: unknown, next: unknown) => {
  const ops = diffValue(prev, next);
  if (ops === null) return null;
  // The ops ride the wire as JSON.
  return applyValuePatch(prev, JSON.parse(JSON.stringify(ops)));
};

describe("diffValue / applyValuePatch", () => {
  test("a string that grew is one append of its suffix", () => {
    const prev = {
      messageId: "m",
      blocks: [{ kind: "text", index: 0, text: "Hel" }],
    };
    const next = {
      messageId: "m",
      blocks: [{ kind: "text", index: 0, text: "Hello" }],
    };
    expect(diffValue(prev, next)).toEqual([
      { at: ["blocks", 0, "text"], append: "lo" },
    ]);
    expect(roundTrip(prev, next)).toEqual(next);
  });

  test("an array that grew pushes its new elements", () => {
    const prev = { blocks: [{ i: 0 }] };
    const next = { blocks: [{ i: 0 }, { i: 1, t: "a" }] };
    expect(diffValue(prev, next)).toEqual([
      { at: ["blocks"], push: [{ i: 1, t: "a" }] },
    ]);
    expect(roundTrip(prev, next)).toEqual(next);
  });

  test("a root that grew is patched at the root", () => {
    expect(diffValue("ab", "abc")).toEqual([{ at: [], append: "c" }]);
    expect(roundTrip("ab", "abc")).toBe("abc");
    expect(roundTrip([1], [1, 2])).toEqual([1, 2]);
  });

  test("nothing changed is no op; the root changing is null", () => {
    expect(diffValue({ a: [1, "x"] }, { a: [1, "x"] })).toEqual([]);
    expect(diffValue({ a: 1 }, null)).toBeNull();
    expect(diffValue({ a: 1, b: 2 }, { a: 1 })).toBeNull();
    expect(diffValue([1, 2], [1])).toBeNull();
    expect(diffValue("abc", "abd")).toBeNull();
    expect(diffValue(1, 2)).toBeNull();
  });

  test("a part that cannot be patched is set whole, and an added member is set", () => {
    const prev = { a: "abc", b: [1, 2], c: { x: 1, y: 2 } };
    const next = { a: "abd", b: [1], c: { x: 1 }, d: true };
    expect(diffValue(prev, next)).toEqual([
      { at: ["a"], set: "abd" },
      { at: ["b"], set: [1] },
      { at: ["c"], set: { x: 1 } },
      { at: ["d"], set: true },
    ]);
    expect(roundTrip(prev, next)).toEqual(next);
  });

  test("an undefined member is absent, as in JSON", () => {
    expect(diffValue({ a: 1, b: undefined }, { a: 1 })).toEqual([]);
    expect(diffValue({ a: 1 }, { a: 1, b: undefined })).toEqual([]);
  });

  test("a non-plain leaf is compared by its JSON", () => {
    expect(diffValue({ at: new Date(5) }, { at: new Date(5) })).toEqual([]);
    expect(diffValue({ at: new Date(5) }, { at: new Date(6) })).toEqual([
      { at: ["at"], set: new Date(6) },
    ]);
  });

  test("every untouched part of the base keeps its identity; the base is not mutated", () => {
    const thinking = { kind: "thinking", text: "long thought" };
    const tool = { kind: "tool", input: '{"a":"x' };
    const prev = { messageId: "m", blocks: [thinking, tool] as unknown[] };
    const frozen = JSON.stringify(prev);
    const next = applyValuePatch(prev, [
      { at: ["blocks", 1, "input"], append: "yz" },
      { at: ["blocks", 1, "input"], append: "!" },
    ]) as typeof prev;
    expect((next.blocks[1] as typeof tool).input).toBe('{"a":"xyz!');
    expect(next.blocks[0]).toBe(thinking);
    expect(next).not.toBe(prev);
    expect(JSON.stringify(prev)).toBe(frozen);
  });

  test("a patch made against another value throws", () => {
    expect(() =>
      applyValuePatch({ a: 1 }, [{ at: ["b", "c"], append: "x" }]),
    ).toThrow();
    expect(() =>
      applyValuePatch({ a: 1 }, [{ at: ["a"], append: "x" }]),
    ).toThrow();
    expect(() =>
      applyValuePatch({ a: "s" }, [{ at: ["a"], push: [1] }]),
    ).toThrow();
    expect(() => applyValuePatch([1], [{ at: [3], set: 1 }])).toThrow();
    expect(() => applyValuePatch({}, [{ at: [], set: 1 }])).toThrow();
    expect(() =>
      applyValuePatch({ a: 1 }, [{ at: ["a", "b"], set: 1 }]),
    ).toThrow();
    expect(() => applyValuePatch({ a: 1 }, [{ at: ["a"] }])).toThrow();
    expect(() =>
      applyValuePatch({ a: "" }, [{ at: ["a"], set: 1, append: "x" }]),
    ).toThrow();
    expect(() => applyValuePatch({ a: 1 }, [{ at: [{}], set: 1 }])).toThrow();
  });

  test("round-trips random JSON edits", () => {
    let seed = 7;
    const rnd = () =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const gen = (depth: number): unknown => {
      const r = rnd();
      if (depth > 3 || r < 0.3)
        return rnd() < 0.5
          ? Math.floor(rnd() * 10)
          : "s".repeat(Math.floor(rnd() * 4));
      if (r < 0.6)
        return Array.from({ length: Math.floor(rnd() * 4) }, () =>
          gen(depth + 1),
        );
      return Object.fromEntries(
        Array.from({ length: Math.floor(rnd() * 4) }, (_, i) => [
          `k${i}`,
          gen(depth + 1),
        ]),
      );
    };
    const mutate = (v: unknown): unknown => {
      const r = rnd();
      if (typeof v === "string")
        return r < 0.7 ? v + "x".repeat(1 + Math.floor(rnd() * 3)) : "other";
      if (Array.isArray(v)) {
        const copy = v.map((e) => (rnd() < 0.4 ? mutate(e) : e));
        if (r < 0.4) copy.push(gen(2));
        if (r > 0.9) copy.pop();
        return copy;
      }
      if (v !== null && typeof v === "object") {
        const copy: Record<string, unknown> = {};
        for (const [k, e] of Object.entries(v))
          if (rnd() > 0.05) copy[k] = rnd() < 0.4 ? mutate(e) : e;
        if (r < 0.2) copy[`n${Math.floor(rnd() * 5)}`] = gen(2);
        return copy;
      }
      return r < 0.5 ? v : gen(3);
    };
    let patched = 0;
    for (let n = 0; n < 2000; n++) {
      const prev = gen(0);
      const next = mutate(prev);
      const out = roundTrip(prev, next);
      if (out !== null) {
        patched++;
        expect(out).toEqual(next as object);
      }
    }
    expect(patched).toBeGreaterThan(500);
  });
});
