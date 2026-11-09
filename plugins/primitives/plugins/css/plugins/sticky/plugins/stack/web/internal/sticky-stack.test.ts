import { describe, expect, test } from "bun:test";
import { stickyStackTop } from "./sticky-stack";

const keys = ["a", "b", "c"];
const heights = new Map([
  ["a", 28],
  ["b", 30],
  ["c", 28],
]);

describe("stickyStackTop", () => {
  test("the first item always pins at the base", () => {
    expect(stickyStackTop({ keys, heights, itemKey: "a", base: "0px", stacked: true })).toBe("0px");
  });

  test("a stacked item pins below the sum of the items preceding it", () => {
    expect(stickyStackTop({ keys, heights, itemKey: "b", base: "0px", stacked: true })).toBe(
      "calc(0px + 28px)",
    );
    expect(stickyStackTop({ keys, heights, itemKey: "c", base: "0px", stacked: true })).toBe(
      "calc(0px + 58px)",
    );
  });

  test("the base can be any CSS length expression", () => {
    expect(
      stickyStackTop({
        keys,
        heights,
        itemKey: "c",
        base: "var(--dv-header-offset, 0px)",
        stacked: true,
      }),
    ).toBe("calc(var(--dv-header-offset, 0px) + 58px)");
  });

  test("not stacked ⇒ every item pins at the base (the swap hand-off)", () => {
    for (const itemKey of keys)
      expect(stickyStackTop({ keys, heights, itemKey, base: "4px", stacked: false })).toBe("4px");
  });

  test("an unmeasured preceding item contributes 0 until its measure lands", () => {
    expect(
      stickyStackTop({ keys, heights: new Map([["b", 30]]), itemKey: "c", base: "0px", stacked: true }),
    ).toBe("calc(0px + 30px)");
  });

  test("a stale height for a key outside `keys` is ignored, not an error", () => {
    expect(
      stickyStackTop({
        keys,
        heights: new Map([...heights, ["gone", 999]]),
        itemKey: "b",
        base: "0px",
        stacked: true,
      }),
    ).toBe("calc(0px + 28px)");
  });

  test("an itemKey absent from `keys` is a wiring bug and throws", () => {
    expect(() =>
      stickyStackTop({ keys, heights, itemKey: "nope", base: "0px", stacked: true }),
    ).toThrow(/not present in its <StickyStack/);
  });
});

describe("stickyStackTop — nested (ancestors)", () => {
  test("past the cap an item pins below its ancestor chain only", () => {
    expect(
      stickyStackTop({
        keys,
        heights,
        itemKey: "c",
        base: "0px",
        stacked: false,
        ancestors: ["a"],
      }),
    ).toBe("calc(0px + 28px)");
    expect(
      stickyStackTop({
        keys,
        heights,
        itemKey: "c",
        base: "0px",
        stacked: false,
        ancestors: ["a", "b"],
      }),
    ).toBe("calc(0px + 58px)");
  });

  test("a root item past the cap pins at the base", () => {
    expect(
      stickyStackTop({
        keys,
        heights,
        itemKey: "b",
        base: "4px",
        stacked: false,
        ancestors: [],
      }),
    ).toBe("4px");
  });

  test("stacked ignores the chain: every preceding item is above", () => {
    expect(
      stickyStackTop({
        keys,
        heights,
        itemKey: "c",
        base: "0px",
        stacked: true,
        ancestors: ["a"],
      }),
    ).toBe("calc(0px + 58px)");
  });
});
