import { describe, expect, it } from "bun:test";
import {
  lowersToMatch,
  testField,
} from "@plugins/primitives/plugins/data-view/web/testing";
import type { FilterFieldValue } from "@plugins/primitives/plugins/data-view/core";
import { tagsLower } from "./tags-lower";

const keeps = (
  op: keyof typeof tagsLower,
  operand: unknown,
  value: FilterFieldValue,
) => lowersToMatch({ lower: tagsLower[op] }, "stringArray", operand, value);

describe("tags operators lowered", () => {
  it("contains / does-not-contain (single tag)", () => {
    expect(keeps("contains", "a", ["a", "b"])).toBe(true);
    expect(keeps("contains", "c", ["a", "b"])).toBe(false);
    expect(keeps("contains", "", ["a"])).toBe(true); // empty operand → keep
    expect(keeps("does-not-contain", "c", ["a", "b"])).toBe(true);
    expect(keeps("does-not-contain", "a", ["a", "b"])).toBe(false);
  });

  it("contains-any-of (match-any)", () => {
    expect(keeps("contains-any-of", ["a", "z"], ["a", "b"])).toBe(true);
    expect(keeps("contains-any-of", ["x", "z"], ["a", "b"])).toBe(false);
    expect(keeps("contains-any-of", [], ["a"])).toBe(true);
  });

  it("contains-all-of (match-all)", () => {
    expect(keeps("contains-all-of", ["a", "b"], ["a", "b", "c"])).toBe(true);
    expect(keeps("contains-all-of", ["a", "z"], ["a", "b"])).toBe(false);
    expect(keeps("contains-all-of", [], ["a"])).toBe(true);
  });

  it("non-array field → no tag set", () => {
    expect(keeps("contains", "a", null)).toBe(false);
    expect(keeps("contains-any-of", ["a"], "a")).toBe(false);
    expect(keeps("does-not-contain", "a", null)).toBe(true);
  });

  it("is-empty / is-not-empty", () => {
    expect(keeps("is-empty", undefined, [])).toBe(true);
    expect(keeps("is-empty", undefined, null)).toBe(true);
    expect(keeps("is-empty", undefined, ["a"])).toBe(false);
    expect(keeps("is-not-empty", undefined, ["a"])).toBe(true);
    expect(keeps("is-not-empty", undefined, [])).toBe(false);
  });

  it("lowers a single tag to a one-element list", () => {
    expect(
      tagsLower.contains("a", {
        column: "tags",
        field: testField("tags"),
        now: 0,
      }),
    ).toEqual({
      column: "tags",
      op: "hasAll",
      operand: ["a"],
    });
  });

  describe("nested", () => {
    const field = {
      id: "v",
      label: "v",
      options: [
        { value: "food", label: "Food" },
        { value: "cafe", label: "Cafe", parent: "food" },
        { value: "park", label: "Park" },
      ],
    };
    const nestedKeeps = (
      op: "has-nested" | "lacks-nested",
      operand: unknown,
      value: FilterFieldValue,
    ) =>
      lowersToMatch(
        { lower: tagsLower[op] },
        "stringArray",
        operand,
        value,
        0,
        field,
      );

    it("has-nested matches descendants of the operand", () => {
      expect(nestedKeeps("has-nested", ["food"], ["cafe"])).toBe(true);
      expect(nestedKeeps("has-nested", ["cafe"], ["food"])).toBe(false);
      expect(nestedKeeps("has-nested", ["food"], ["park"])).toBe(false);
      expect(nestedKeeps("has-nested", [], ["park"])).toBe(true);
    });

    it("lacks-nested excludes the closure", () => {
      expect(nestedKeeps("lacks-nested", ["food"], ["cafe"])).toBe(false);
      expect(nestedKeeps("lacks-nested", ["food"], ["park"])).toBe(true);
      expect(nestedKeeps("lacks-nested", ["food"], null)).toBe(true);
    });

    it("on a flat list is the operand itself", () => {
      const flat = tagsLower["has-nested"](["a"], {
        column: "c",
        field: testField("c"),
        now: 0,
      });
      expect(flat).toEqual({ column: "c", op: "hasAny", operand: ["a"] });
    });
  });
});
