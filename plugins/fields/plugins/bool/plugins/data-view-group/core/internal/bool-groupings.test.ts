import { describe, expect, test } from "bun:test";
import type {
  FieldDef,
  FieldValue,
  GroupBucket,
  GroupingPlanContext,
} from "@plugins/primitives/plugins/data-view/core";
import { boolGroupings } from "./bool-groupings";

const CTX: GroupingPlanContext = {
  now: new Date("2026-08-26T00:00:00").getTime(),
  values: [true, false],
  field: { id: "done", label: "Done", type: "bool" } as FieldDef<unknown>,
};

/** The bucket `value` is filed in. The bool grouping is TOTAL — every value is
 *  either truthy or falsy — so a `null` ("not a value I can bucket") is a test
 *  failure rather than an arm. */
function bucket(value: FieldValue): GroupBucket {
  const seen = boolGroupings[0]!.plan(CTX)(value);
  if (seen === null) {
    throw new Error(`the bool grouping could not bucket ${String(value)}`);
  }
  return seen;
}

describe("boolGroupings", () => {
  test("offers exactly ONE grouping, so no granularity band is shown", () => {
    expect(boolGroupings).toHaveLength(1);
    expect(boolGroupings[0]!.id).toBe("value");
    expect(boolGroupings[0]!.label).toBe("Value");
  });

  test("true is the Yes section, false is the No section", () => {
    expect(bucket(true)).toEqual({ key: "true", label: "Yes", order: 1 });
    expect(bucket(false)).toEqual({ key: "false", label: "No", order: 0 });
  });

  test("a field names its sections through its options", () => {
    const plan = boolGroupings[0]!.plan({
      ...CTX,
      field: {
        id: "read",
        label: "Read",
        type: "bool",
        options: [
          { value: "false", label: "Unread" },
          { value: "true", label: "Read" },
        ],
      } as FieldDef<unknown>,
    });
    expect(plan(false)).toEqual({ key: "false", label: "Unread", order: 0 });
    expect(plan(true)).toEqual({ key: "true", label: "Read", order: 1 });
  });

  test("No sorts before Yes — the type's own `asc` reading", () => {
    expect(bucket(false).order).toBeLessThan(bucket(true).order);
  });

  test("the bucket key is the stringified value, so collapse state survives", () => {
    expect([bucket(false).key, bucket(true).key]).toEqual(["false", "true"]);
  });

  // The grouping never returns `null`, and that is deliberate rather than an
  // oversight. Data-view's old `sectionLabel` read `value ? "Yes" : "No"` for
  // ANY value a bool field projected, so a non-boolean that slipped through
  // landed in Yes/No by truthiness. Returning `null` here would move such a row
  // into the "None" section instead — a behaviour change, in the one migration
  // whose whole point is that grouping behaves exactly as it did.
  test("a non-boolean still buckets by truthiness — never null", () => {
    expect(bucket("anything")).toEqual({
      key: "anything",
      label: "Yes",
      order: 1,
    });
    expect(bucket(0)).toEqual({ key: "0", label: "No", order: 0 });
  });
});
