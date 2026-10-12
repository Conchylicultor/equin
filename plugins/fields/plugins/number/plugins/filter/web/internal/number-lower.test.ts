import { describe, expect, it } from "bun:test";
import {
  lowersToMatch,
  testField,
} from "@plugins/primitives/plugins/data-view/web/testing";
import type { FilterFieldValue } from "@plugins/primitives/plugins/data-view/core";
import { numberLower } from "./number-lower";

const keeps = (
  op: keyof typeof numberLower,
  operand: unknown,
  value: FilterFieldValue,
) => lowersToMatch({ lower: numberLower[op] }, "number", operand, value);

describe("number operators lowered", () => {
  it("= / ≠", () => {
    expect(keeps("=", 5, 5)).toBe(true);
    expect(keeps("=", 5, 6)).toBe(false);
    expect(keeps("≠", 5, 6)).toBe(true);
    expect(keeps("≠", 5, 5)).toBe(false);
  });

  it("> < ≥ ≤", () => {
    expect(keeps(">", 5, 10)).toBe(true);
    expect(keeps(">", 5, 5)).toBe(false);
    expect(keeps("<", 5, 1)).toBe(true);
    expect(keeps("≥", 5, 5)).toBe(true);
    expect(keeps("≤", 5, 5)).toBe(true);
    expect(keeps("≤", 5, 6)).toBe(false);
  });

  it("empty operand → keep (incomplete rule)", () => {
    expect(keeps("=", undefined, 5)).toBe(true);
    expect(keeps(">", null, 5)).toBe(true);
    expect(
      numberLower["="]("5", { column: "n", field: testField("n"), now: 0 }),
    ).toBeUndefined();
  });

  it("non-numeric field value → drop (when operand present)", () => {
    expect(keeps("=", 5, null)).toBe(false);
    expect(keeps(">", 5, "x")).toBe(false); // the adapter reads "x" as NULL
  });

  // DECIDED CHANGE (research/2026-09-25-global-unified-filter-language.md):
  // negatives are complements, so `≠` now KEEPS a row with no value — it used
  // to drop it (`neq(5, null) === false`).
  it("≠ keeps NULL (complement of =)", () => {
    expect(keeps("≠", 5, null)).toBe(true);
    expect(keeps("≠", 5, undefined)).toBe(true);
  });

  it("between (inclusive, open bounds)", () => {
    expect(keeps("between", { min: 1, max: 10 }, 5)).toBe(true);
    expect(keeps("between", { min: 1, max: 10 }, 1)).toBe(true);
    expect(keeps("between", { min: 1, max: 10 }, 10)).toBe(true);
    expect(keeps("between", { min: 1, max: 10 }, 11)).toBe(false);
    expect(keeps("between", { min: 5 }, 7)).toBe(true);
    expect(keeps("between", { max: 5 }, 7)).toBe(false);
    expect(keeps("between", {}, 7)).toBe(true); // no bounds → keep
    expect(keeps("between", { min: 1 }, null)).toBe(false);
    expect(
      numberLower.between({}, { column: "n", field: testField("n"), now: 0 }),
    ).toBeUndefined();
  });

  it("is-empty / is-not-empty", () => {
    expect(keeps("is-empty", undefined, null)).toBe(true);
    expect(keeps("is-empty", undefined, undefined)).toBe(true);
    expect(keeps("is-empty", undefined, 0)).toBe(false);
    expect(keeps("is-not-empty", undefined, 0)).toBe(true);
    expect(keeps("is-not-empty", undefined, null)).toBe(false);
  });
});
