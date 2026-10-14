import { describe, expect, it } from "bun:test";
import {
  lowersToMatch,
  testField,
} from "@plugins/primitives/plugins/data-view/web/testing";
import type {
  FieldDef,
  FilterFieldValue,
} from "@plugins/primitives/plugins/data-view/core";
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

  it('an option spelled "null" picks the no-value', () => {
    expect(keeps("is", "null", null)).toBe(true);
    expect(keeps("is", "null", "open")).toBe(false);
    expect(keeps("is-not", "null", null)).toBe(false);
    expect(keeps("is-not", "null", "open")).toBe(true);
    expect(keeps("is-any-of", ["open", "null"], null)).toBe(true);
    expect(keeps("is-any-of", ["open", "null"], "open")).toBe(true);
    expect(keeps("is-any-of", ["open", "null"], "wip")).toBe(false);
    expect(keeps("is-none-of", ["open", "null"], null)).toBe(false);
    expect(keeps("is-none-of", ["open", "null"], "wip")).toBe(true);
  });

  it("over a boolean valueDomain, an option reads back as its boolean", () => {
    const verdict: FieldDef<unknown> = {
      id: "v",
      label: "Status",
      valueDomain: "boolean",
    };
    const bool = (
      op: keyof typeof enumLower,
      operand: unknown,
      value: FilterFieldValue,
    ) =>
      lowersToMatch(
        { lower: enumLower[op] },
        "boolean",
        operand,
        value,
        0,
        verdict,
      );
    expect(bool("is", "true", true)).toBe(true);
    expect(bool("is", "true", false)).toBe(false);
    expect(bool("is", "null", null)).toBe(true);
    expect(bool("is-not", "false", null)).toBe(true);
    expect(bool("is-any-of", ["false", "null"], false)).toBe(true);
    expect(bool("is-any-of", ["false", "null"], true)).toBe(false);
    expect(bool("is-none-of", ["true", "null"], false)).toBe(true);
    expect(bool("is-none-of", ["true", "null"], null)).toBe(false);
    // A stale option spells no boolean: `is` matches nothing, `is-not` everything.
    expect(bool("is", "yes", true)).toBe(false);
    expect(bool("is-not", "yes", true)).toBe(true);
    const ctx = { column: "ok", field: verdict, now: 0 };
    expect(enumLower["is-any-of"](["true", "null"], ctx)).toEqual({
      or: [
        { column: "ok", op: "eq", operand: true },
        { column: "ok", op: "isEmpty" },
      ],
    });
  });
});
