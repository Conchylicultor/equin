import { describe, expect, it } from "bun:test";
import {
  lowersToMatch,
  testField,
} from "@plugins/primitives/plugins/data-view/web/testing";
import type { FilterFieldValue } from "@plugins/primitives/plugins/data-view/core";
import { textLower } from "./text-lower";

const keeps = (
  op: keyof typeof textLower,
  operand: unknown,
  value: FilterFieldValue,
) => lowersToMatch({ lower: textLower[op] }, "text", operand, value);

describe("text operators lowered", () => {
  it("contains (case-insensitive, empty operand → keep)", () => {
    expect(keeps("contains", "AN", "Annie")).toBe(true);
    expect(keeps("contains", "xyz", "Annie")).toBe(false);
    expect(keeps("contains", "", "Annie")).toBe(true);
    expect(keeps("contains", "an", null)).toBe(false);
  });

  it("does-not-contain", () => {
    expect(keeps("does-not-contain", "xyz", "Annie")).toBe(true);
    expect(keeps("does-not-contain", "an", "Annie")).toBe(false);
    expect(keeps("does-not-contain", "", "Annie")).toBe(true);
    expect(keeps("does-not-contain", "x", null)).toBe(true);
  });

  it("is / is-not (case-insensitive)", () => {
    expect(keeps("is", "annie", "Annie")).toBe(true);
    expect(keeps("is", "bob", "Annie")).toBe(false);
    expect(keeps("is", "", "Annie")).toBe(true);
    expect(keeps("is-not", "bob", "Annie")).toBe(true);
    expect(keeps("is-not", "annie", "Annie")).toBe(false);
  });

  it("is-empty / is-not-empty", () => {
    expect(keeps("is-empty", undefined, "")).toBe(true);
    expect(keeps("is-empty", undefined, null)).toBe(true);
    expect(keeps("is-empty", undefined, "  ")).toBe(true);
    expect(keeps("is-empty", undefined, "x")).toBe(false);
    expect(keeps("is-not-empty", undefined, "x")).toBe(true);
    expect(keeps("is-not-empty", undefined, "")).toBe(false);
  });

  it("an incomplete rule lowers to undefined (the chip does not count it)", () => {
    const ctx = { column: "title", field: testField("title"), now: 0 };
    expect(textLower.contains("", ctx)).toBeUndefined();
    expect(textLower.is(undefined, ctx)).toBeUndefined();
    expect(textLower.contains("an", ctx)).toEqual({
      column: "title",
      op: "contains",
      operand: "an",
    });
  });
});
