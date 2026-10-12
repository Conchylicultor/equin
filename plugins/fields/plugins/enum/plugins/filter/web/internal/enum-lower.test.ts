import { describe, expect, it } from "bun:test";
import {
  lowersToMatch,
  testField,
} from "@plugins/primitives/plugins/data-view/web/testing";
import type { FilterFieldValue } from "@plugins/primitives/plugins/data-view/core";
import { enumLower } from "./enum-lower";

const keeps = (
  op: keyof typeof enumLower,
  operand: unknown,
  value: FilterFieldValue,
) => lowersToMatch({ lower: enumLower[op] }, "text", operand, value);

describe("enum operators lowered", () => {
  it("is / is-not", () => {
    expect(keeps("is", "open", "open")).toBe(true);
    expect(keeps("is", "open", "closed")).toBe(false);
    expect(keeps("is", "", "open")).toBe(true); // empty operand → keep
    expect(keeps("is-not", "closed", "open")).toBe(true);
    expect(keeps("is-not", "open", "open")).toBe(false);
    expect(keeps("is-not", "open", null)).toBe(true); // complement keeps NULL
  });

  it("is-any-of", () => {
    expect(keeps("is-any-of", ["open", "wip"], "wip")).toBe(true);
    expect(keeps("is-any-of", ["open", "wip"], "done")).toBe(false);
    expect(keeps("is-any-of", [], "done")).toBe(true); // empty operand → keep
  });

  it("is-none-of", () => {
    expect(keeps("is-none-of", ["open", "wip"], "done")).toBe(true);
    expect(keeps("is-none-of", ["open", "wip"], "open")).toBe(false);
    expect(keeps("is-none-of", [], "open")).toBe(true);
    expect(keeps("is-none-of", ["open"], null)).toBe(true);
  });

  it("is-empty / is-not-empty", () => {
    expect(keeps("is-empty", undefined, null)).toBe(true);
    expect(keeps("is-empty", undefined, "")).toBe(true);
    expect(keeps("is-empty", undefined, "open")).toBe(false);
    expect(keeps("is-not-empty", undefined, "open")).toBe(true);
    expect(keeps("is-not-empty", undefined, undefined)).toBe(false);
  });

  it("lowers to the language's ops", () => {
    const ctx = { column: "status", field: testField("status"), now: 0 };
    expect(enumLower["is-any-of"](["a", 3, "b"], ctx)).toEqual({
      column: "status",
      op: "in",
      operand: ["a", "b"],
    });
    expect(enumLower["is-none-of"]([], ctx)).toBeUndefined();
  });
});
