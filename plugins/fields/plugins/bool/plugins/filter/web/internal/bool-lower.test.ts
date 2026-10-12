import { describe, expect, it } from "bun:test";
import {
  lowersToMatch,
  testField,
} from "@plugins/primitives/plugins/data-view/web/testing";
import type { FilterFieldValue } from "@plugins/primitives/plugins/data-view/core";
import { boolLower } from "./bool-lower";

const keeps = (
  op: keyof typeof boolLower,
  operand: unknown,
  value: FilterFieldValue,
) => lowersToMatch({ lower: boolLower[op] }, "boolean", operand, value);

describe("bool operators lowered", () => {
  it("is (checked / unchecked)", () => {
    expect(keeps("is", true, true)).toBe(true);
    expect(keeps("is", true, false)).toBe(false);
    expect(keeps("is", false, false)).toBe(true);
    expect(keeps("is", false, true)).toBe(false);
  });

  it("treats falsy field values as unchecked", () => {
    expect(keeps("is", false, null)).toBe(true);
    expect(keeps("is", false, undefined)).toBe(true);
    expect(keeps("is", true, null)).toBe(false);
  });

  it("unset operand defaults to unchecked (and is complete)", () => {
    expect(keeps("is", undefined, false)).toBe(true);
    expect(keeps("is", undefined, true)).toBe(false);
    expect(
      boolLower.is(undefined, {
        column: "done",
        field: testField("done"),
        now: 0,
      }),
    ).toEqual({
      column: "done",
      op: "ne",
      operand: true,
    });
  });

  it("is-not", () => {
    expect(keeps("is-not", true, false)).toBe(true);
    expect(keeps("is-not", true, true)).toBe(false);
    expect(keeps("is-not", false, true)).toBe(true);
    expect(keeps("is-not", true, null)).toBe(true);
  });
});
