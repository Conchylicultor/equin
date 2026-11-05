import { describe, expect, test } from "bun:test";
import type { FieldDef, FieldValue } from "../../core";
import { IDENTITY_GROUPING } from "./identity-grouping";

/** The section keys a partition would render, in ascending ordinal order. */
function sectionKeys(
  values: readonly FieldValue[],
  field: Partial<FieldDef<unknown>> = {},
): string[] {
  const bucket = IDENTITY_GROUPING.plan({
    now: 0,
    values,
    field: { id: "f", label: "F", ...field } as FieldDef<unknown>,
  });
  const byKey = new Map<string, number>();
  for (const v of values) {
    const b = bucket(v)!;
    if (!byKey.has(b.key)) byKey.set(b.key, b.order);
  }
  return [...byKey].sort(([, a], [, b]) => a - b).map(([k]) => k);
}

describe("IDENTITY_GROUPING", () => {
  test("orders sections by value", () => {
    expect(sectionKeys(["b", "c", "a", "b"])).toEqual(["a", "b", "c"]);
  });

  test("an ordinal field orders them by its declared order, unlisted values last", () => {
    expect(
      sectionKeys(["zzz", "low", "high", "mid", "aaa"], {
        valueOrder: ["low", "mid", "high"],
      }),
    ).toEqual(["low", "mid", "high", "aaa", "zzz"]);
  });
});
