import { describe, expect, test } from "bun:test";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type {
  FieldDef,
  FieldValue,
  GroupBucket,
  GroupingPlanContext,
} from "@plugins/primitives/plugins/data-view/core";
import { enumGroupings } from "./enum-groupings";

const OPTIONS = [
  { value: "todo", label: "To do" },
  { value: "doing", label: "In progress" },
  { value: "done", label: "Done" },
];

const NOW = new Date("2026-08-26T00:00:00").getTime();

/** Bucket every value the way `partitionIntoSections` does: plan once, then
 *  call the returned bucketer per value.
 *
 *  The enum grouping is TOTAL — it stringifies whatever it is handed — so a
 *  `null` ("not a value I can bucket") is a test failure rather than an arm. */
function bucketAll(
  values: readonly FieldValue[],
  field: Partial<FieldDef<unknown>> = {},
): GroupBucket[] {
  const ctx: GroupingPlanContext = {
    now: NOW,
    values,
    field: {
      id: "status",
      label: "Status",
      type: "enum",
      ...field,
    } as FieldDef<unknown>,
  };
  const bucket = enumGroupings[0]!.plan(ctx);
  return values.map((value) => {
    const seen = bucket(value);
    if (seen === null) {
      throw new Error(`the enum grouping could not bucket ${String(value)}`);
    }
    return seen;
  });
}

/** The section list a partition would render: deduped by key, order-sorted. */
function sectionKeys(
  values: readonly FieldValue[],
  field: Partial<FieldDef<unknown>> = {},
) {
  const byKey = new Map<string, GroupBucket>();
  for (const b of bucketAll(values, field))
    if (!byKey.has(b.key)) byKey.set(b.key, b);
  return [...byKey.values()].sort((a, b) => a.order - b.order);
}

describe("enumGroupings", () => {
  test("offers exactly ONE grouping, so no granularity band is shown", () => {
    expect(enumGroupings).toHaveLength(1);
    expect(enumGroupings[0]!.id).toBe("value");
    expect(enumGroupings[0]!.label).toBe("Value");
  });

  test("keys on the stringified value", () => {
    expect(bucketAll(["doing"], { options: OPTIONS })[0]!.key).toBe("doing");
  });

  test("labels from the matching option, whatever order the values arrive in", () => {
    expect(
      bucketAll(["done", "todo"], { options: OPTIONS }).map((b) => b.label),
    ).toEqual(["Done", "To do"]);
  });

  test("sections follow `field.options` order, not discovery order", () => {
    expect(
      sectionKeys(["done", "todo", "doing"], { options: OPTIONS }).map(
        (s) => s.key,
      ),
    ).toEqual(["todo", "doing", "done"]);
  });

  test("an option with no rows simply never appears (order stays sparse)", () => {
    expect(
      sectionKeys(["done", "todo"], { options: OPTIONS }).map((s) => s.order),
    ).toEqual([0, 2]);
  });

  test("a value with no option falls back to its stringified self as the label", () => {
    expect(bucketAll(["archived"], { options: OPTIONS })[0]!.label).toBe(
      "archived",
    );
  });

  test("unknown values sort AFTER every known one, among themselves value-sorted", () => {
    expect(
      sectionKeys(["zeta", "done", "alpha", "todo"], {
        options: OPTIONS,
      }).map((s) => s.key),
    ).toEqual(["todo", "done", "alpha", "zeta"]);
  });

  test("an unknown value is still after a known one that has no rows", () => {
    // "doing" (index 1) has no rows; "alpha" must not slot into the gap.
    const sections = sectionKeys(["alpha", "done"], { options: OPTIONS });
    expect(sections.map((s) => s.key)).toEqual(["done", "alpha"]);
    expect(sections.map((s) => s.order)).toEqual([2, 3]);
  });

  test("with NO options every value is unknown, so order is plain value order", () => {
    expect(sectionKeys(["c", "a", "b"]).map((s) => s.key)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("with no options the label is the stringified value", () => {
    expect(bucketAll(["a"])[0]!.label).toBe("a");
  });

  test("a duplicated option value keeps its FIRST declared position", () => {
    const options = [
      { value: "b", label: "Bee" },
      { value: "a", label: "Ay" },
      { value: "b", label: "Bee again" },
    ];
    const sections = sectionKeys(["a", "b"], { options });
    expect(sections.map((s) => s.key)).toEqual(["b", "a"]);
    expect(sections[0]!.label).toBe("Bee");
  });

  // The grouping never returns `null`, and that is deliberate rather than an
  // oversight. Data-view's old `sectionLabel` stringified whatever an enum
  // field projected, so an unrecognised value got its own section labelled with
  // the raw value. Returning `null` here would move such a row into the "None"
  // section instead — a behaviour change, in the one migration whose whole
  // point is that grouping behaves exactly as it did. Every case above that
  // passes a value outside `options` covers it.
  test("non-string values are keyed and compared through their string form", () => {
    // Numbers compare numerically (10 after 2), not lexicographically.
    expect(sectionKeys([10, 2]).map((s) => s.key)).toEqual(["2", "10"]);
  });

  test("planning is done once — the bucketer is reused across values", () => {
    let reads = 0;
    const options = OPTIONS;
    const field = {
      id: "status",
      label: "Status",
      type: "enum",
      get options() {
        reads++;
        return options;
      },
    } as unknown as FieldDef<unknown>;
    const bucket = enumGroupings[0]!.plan({
      now: NOW,
      values: ["todo", "doing", "done"],
      field,
    });
    const before = reads;
    bucket("todo");
    bucket("doing");
    // The label lookup reads the SAME array captured at plan time.
    expect(reads).toBe(before);
  });
});

describe("enum grouping: the option's identity rides the bucket", () => {
  test("copies the matched option's icon and tint; leaves them off otherwise", () => {
    const icon = symbol("list");
    const [doing, done, stale] = bucketAll(["doing", "done", "gone"], {
      options: [
        { value: "doing", label: "In progress", icon, tint: "--categorical-3" },
        { value: "done", label: "Done" },
      ],
    });
    expect(doing!.icon).toEqual(icon);
    expect(doing!.tint).toBe("--categorical-3");
    expect("icon" in done! || "tint" in done!).toBe(false);
    expect("icon" in stale! || "tint" in stale!).toBe(false);
  });
});
