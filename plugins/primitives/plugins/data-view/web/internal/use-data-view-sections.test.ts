import { describe, expect, test } from "bun:test";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  formatSectionCount,
  sumSectionCounts,
  visibleSections,
  type DataViewSection,
  type DataViewSectioning,
  type DataViewSectionPaging,
  type FieldDef,
  type FieldGrouping,
  type GroupByRule,
} from "../../core";
import { IDENTITY_GROUPING } from "./identity-grouping";
import {
  aggregateSections,
  isGroupableField,
  NULL_GROUP_KEY,
  orderSectionsByRank,
  partitionIntoSections,
  rollUpNestedCounts,
  type PartitionOptions,
} from "./use-data-view-sections";
import { foldSections } from "./fold-sections";

/**
 * The grouping registry, stubbed. `partitionIntoSections` never reads a slot —
 * it takes the resolver — which is exactly what lets these run under `bun:test`
 * with no React and no plugin runtime.
 */
function stubOpts<TRow = unknown>(
  groupings: Record<string, FieldGrouping> = {},
  order: "asc" | "desc" = "asc",
  now = 0,
): PartitionOptions<TRow> {
  return {
    now,
    order,
    resolveGrouping: (typeId, groupingId) =>
      groupings[`${typeId}:${groupingId}`] ??
      groupings[typeId] ??
      IDENTITY_GROUPING,
  };
}

/** `groupBy` as the views persist it: field + the grouping to bucket with. */
const by = (
  fieldId: string,
  groupingId = IDENTITY_GROUPING.id,
): GroupByRule => ({
  fieldId,
  groupingId,
});

/** Every field type declares groupings in the real app; the pure tests below
 *  only need "does this type declare any", so a set of type tokens says it. */
const hasGroupingIn =
  (...types: string[]) =>
  (typeId: string) =>
    types.includes(typeId);

interface Task {
  id: string;
  status: string | null;
}

const statusField: FieldDef<Task> = {
  id: "status",
  label: "Status",
  type: "enum",
  value: (t) => t.status,
  options: [
    { value: "todo", label: "To do" },
    { value: "doing", label: "Doing" },
    { value: "done", label: "Done" },
  ],
};

const rowKey = (t: Task) => t.id;

/**
 * A stand-in for what the `enum` type's own sub-plugin contributes: label from
 * `field.options`, ordinal = index in `options` (unknown values after known,
 * value-sorted). Written here as a STUB rather than imported, so this suite
 * proves the mechanism (a grouping's ordinal drives section order) without
 * knowing that any particular field type exists.
 */
const optionOrderGrouping: FieldGrouping = {
  id: "value",
  label: "Value",
  plan: ({ field, values }) => {
    const options = field.options ?? [];
    const known = new Map(options.map((o, i) => [o.value, i]));
    const unknown = [...new Set(values.map((v) => String(v)))]
      .filter((k) => !known.has(k))
      .sort();
    return (value) => {
      const key = String(value);
      const index = known.get(key);
      return {
        key,
        label: options.find((o) => o.value === key)?.label ?? key,
        order: index ?? options.length + unknown.indexOf(key),
      };
    };
  },
};

describe("partitionIntoSections", () => {
  test("ungrouped → a single null section mapping rows 1:1", () => {
    const rows: Task[] = [
      { id: "a", status: "todo" },
      { id: "b", status: "done" },
    ];
    const sections = partitionIntoSections(
      rows,
      [statusField],
      undefined,
      rowKey,
      stubOpts(),
    );
    expect(sections).toHaveLength(1);
    const [only] = sections;
    expect(only!.key).toBeNull();
    expect(only!.label).toBeUndefined();
    expect(only!.count).toEqual({ kind: "exact", n: 2 });
    expect(only!.entries.map((e) => e.row)).toEqual(rows);
    expect(only!.entries.map((e) => e.key)).toEqual(["a", "b"]);
  });

  test("unresolvable group field falls back to the single null section", () => {
    const rows: Task[] = [{ id: "a", status: "todo" }];
    const sections = partitionIntoSections(
      rows,
      [statusField],
      by("missing"),
      rowKey,
      stubOpts(),
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]!.key).toBeNull();
  });

  test("the grouping's `order` drives section order — not discovery, not value", () => {
    const rows: Task[] = [
      { id: "1", status: "done" },
      { id: "2", status: "todo" },
      { id: "3", status: "todo" },
      { id: "4", status: "doing" },
    ];
    const sections = partitionIntoSections(
      rows,
      [statusField],
      by("status"),
      rowKey,
      stubOpts({ enum: optionOrderGrouping }),
    );
    // The grouping's ordinal (options order: todo, doing, done), NOT discovery
    // order (done, todo, doing) and NOT value order (doing, done, todo).
    expect(sections.map((s) => s.key)).toEqual(["todo", "doing", "done"]);
    expect(sections.map((s) => s.label)).toEqual(["To do", "Doing", "Done"]);
    expect(sections.map((s) => s.count.n)).toEqual([2, 1, 1]);
    // Within-section row order preserved (the two "todo" rows in input order).
    expect(sections[0]!.entries.map((e) => e.key)).toEqual(["2", "3"]);
  });

  test('order: "desc" reverses the sections', () => {
    const rows: Task[] = [
      { id: "1", status: "done" },
      { id: "2", status: "todo" },
      { id: "3", status: "doing" },
    ];
    const sections = partitionIntoSections(
      rows,
      [statusField],
      by("status"),
      rowKey,
      stubOpts({ enum: optionOrderGrouping }, "desc"),
    );
    expect(sections.map((s) => s.key)).toEqual(["done", "doing", "todo"]);
  });

  test("the None bucket stays LAST in both directions", () => {
    const rows: Task[] = [
      { id: "1", status: null },
      { id: "2", status: "todo" },
      { id: "3", status: "done" },
    ];
    const asc = partitionIntoSections(
      rows,
      [statusField],
      by("status"),
      rowKey,
      stubOpts({ enum: optionOrderGrouping }, "asc"),
    );
    const desc = partitionIntoSections(
      rows,
      [statusField],
      by("status"),
      rowKey,
      stubOpts({ enum: optionOrderGrouping }, "desc"),
    );
    expect(asc.map((s) => s.label)).toEqual(["To do", "Done", "None"]);
    expect(desc.map((s) => s.label)).toEqual(["Done", "To do", "None"]);
  });

  test('the None section takes the label of the option spelled "null"', () => {
    const rows: Task[] = [
      { id: "1", status: null },
      { id: "2", status: "todo" },
    ];
    const byHand = {
      ...statusField,
      options: [
        ...(statusField.options ?? []),
        { value: "null", label: "By hand" },
      ],
    };
    const sections = partitionIntoSections(
      rows,
      [byHand],
      by("status"),
      rowKey,
      stubOpts({ enum: optionOrderGrouping }, "asc"),
    );
    expect(sections.map((s) => [s.key, s.label])).toEqual([
      ["todo", "To do"],
      [NULL_GROUP_KEY, "By hand"],
    ]);
  });

  test("the resolved grouping is planned ONCE, over every non-null value", () => {
    const seen: unknown[][] = [];
    const spy: FieldGrouping = {
      id: "spy",
      label: "Spy",
      plan: (ctx) => {
        seen.push([...ctx.values]);
        return (value) => ({
          key: String(value),
          label: String(value),
          order: 0,
        });
      },
    };
    const rows: Task[] = [
      { id: "1", status: "todo" },
      { id: "2", status: null },
      { id: "3", status: "done" },
    ];
    partitionIntoSections(
      rows,
      [statusField],
      by("status", "spy"),
      rowKey,
      stubOpts({ "enum:spy": spy }),
    );
    expect(seen).toEqual([["todo", "done"]]);
  });

  test("a bucketer returning null routes the row to the SAME None section", () => {
    // The date case: a non-null value the grouping cannot read. It must not mint
    // a second section also labelled "None".
    const parseable: FieldGrouping = {
      id: "parse",
      label: "Parse",
      plan: () => (value) =>
        String(value).startsWith("ok")
          ? { key: String(value), label: String(value), order: 0 }
          : null,
    };
    const rows: Task[] = [
      { id: "1", status: "ok-a" },
      { id: "2", status: "garbage" },
      { id: "3", status: null },
      { id: "4", status: "also-bad" },
    ];
    const sections = partitionIntoSections(
      rows,
      [statusField],
      by("status", "parse"),
      rowKey,
      stubOpts({ "enum:parse": parseable }),
    );
    // Exactly ONE "None", holding the unparseable rows AND the null row.
    expect(sections.filter((s) => s.label === "None")).toHaveLength(1);
    const none = sections.at(-1)!;
    expect(none.label).toBe("None");
    expect(none.count).toEqual({ kind: "exact", n: 3 });
    expect(none.entries.map((e) => e.row.id)).toEqual(["2", "3", "4"]);
  });

  test("an all-unbucketable set is just the None section", () => {
    const never: FieldGrouping = {
      id: "never",
      label: "Never",
      plan: () => () => null,
    };
    const sections = partitionIntoSections(
      [{ id: "1", status: "x" }],
      [statusField],
      by("status", "never"),
      rowKey,
      stubOpts({ "enum:never": never }),
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]!.label).toBe("None");
  });

  test("a non-finite bucket order throws, naming the grouping", () => {
    const infinite: FieldGrouping = {
      id: "infinite",
      label: "Infinite",
      plan: () => (value) => ({
        key: String(value),
        label: String(value),
        order: Number.POSITIVE_INFINITY,
      }),
    };
    expect(() =>
      partitionIntoSections(
        [{ id: "1", status: "x" }],
        [statusField],
        by("status", "infinite"),
        rowKey,
        stubOpts({ "enum:infinite": infinite }),
      ),
    ).toThrow(/non-finite order/);
  });

  test("the injected `now` reaches the plan context verbatim", () => {
    let seenNow = -1;
    const clockGrouping: FieldGrouping = {
      id: "clock",
      label: "Clock",
      plan: (ctx) => {
        seenNow = ctx.now;
        return () => ({ key: "k", label: "k", order: 0 });
      },
    };
    partitionIntoSections(
      [{ id: "1", status: "todo" }],
      [statusField],
      by("status", "clock"),
      rowKey,
      stubOpts({ "enum:clock": clockGrouping }, "asc", 1_700_000_000_000),
    );
    expect(seenNow).toBe(1_700_000_000_000);
  });

  test("null/missing group value → a sensible trailing 'None' bucket", () => {
    const rows: Task[] = [
      { id: "1", status: null },
      { id: "2", status: "todo" },
    ];
    const sections = partitionIntoSections(
      rows,
      [statusField],
      by("status"),
      rowKey,
      stubOpts(),
    );
    expect(sections.map((s) => s.key)).toEqual(["todo", expect.any(String)]);
    const noneSection = sections[1]!;
    expect(noneSection.label).toBe("None");
    expect(noneSection.count).toEqual({ kind: "exact", n: 1 });
    expect(noneSection.entries[0]!.row.id).toBe("1");
    // The null bucket key is the internal sentinel, distinct from any real value.
    expect(noneSection.key).not.toBe("todo");
  });
});

interface Item {
  id: string;
  group: string | null;
}

describe("aggregateSections", () => {
  const itemKey = (i: Item) => i.id;
  const getKey = (i: Item) => i.group;
  const ungrouped = (rows: Item[]) =>
    partitionIntoSections(rows, [], undefined, itemKey, stubOpts());

  test("collapses N rows sharing a key into one representative + count + members", () => {
    const rows: Item[] = [
      { id: "a", group: "g1" },
      { id: "b", group: "g1" },
      { id: "c", group: "g1" },
    ];
    const [section] = aggregateSections(ungrouped(rows), { getKey });
    expect(section!.entries).toHaveLength(1);
    const [entry] = section!.entries;
    expect(entry!.aggregateCount).toBe(3);
    expect(entry!.members?.map((m) => m.id)).toEqual(["a", "b", "c"]);
    // Default representative = first member in current order.
    expect(entry!.row.id).toBe("a");
    expect(entry!.key).toBe("a");
    // section.count is the post-collapse entry count — the rows shown.
    expect(section!.count).toEqual({ kind: "exact", n: 1 });
  });

  test("a lower-bound count stays a lower bound, recounted to the entries", () => {
    const section: DataViewSection<Item> = {
      key: null,
      count: { kind: "atLeast", n: 3 },
      entries: [
        { row: { id: "a", group: "g" }, key: "a" },
        { row: { id: "b", group: "g" }, key: "b" },
        { row: { id: "c", group: null }, key: "c" },
      ],
    };
    const [agg] = aggregateSections([section], { getKey: (i) => i.group });
    expect(agg!.count).toEqual({ kind: "atLeast", n: 2 });
  });

  test("null keys pass through 1:1 with no aggregateCount/members", () => {
    const rows: Item[] = [
      { id: "a", group: null },
      { id: "b", group: "g1" },
      { id: "c", group: "g1" },
      { id: "d", group: null },
    ];
    const [section] = aggregateSections(ungrouped(rows), { getKey });
    // a (passthrough), g1 representative at b's slot, d (passthrough).
    expect(section!.entries.map((e) => e.row.id)).toEqual(["a", "b", "d"]);
    const [a, g1, d] = section!.entries;
    expect(a!.aggregateCount).toBeUndefined();
    expect(a!.members).toBeUndefined();
    expect(g1!.aggregateCount).toBe(2);
    expect(g1!.members?.map((m) => m.id)).toEqual(["b", "c"]);
    expect(d!.aggregateCount).toBeUndefined();
  });

  test("pickRepresentative override respected; entry keeps first member's position + key", () => {
    const rows: Item[] = [
      { id: "x", group: null },
      { id: "a", group: "g1" },
      { id: "b", group: "g1" },
      { id: "y", group: null },
    ];
    const pickRepresentative = (members: readonly Item[]) =>
      members[members.length - 1]!;
    const [section] = aggregateSections(ungrouped(rows), {
      getKey,
      pickRepresentative,
    });
    // Order: x, <g1 at a's slot>, y. Representative row = b (last picked), but
    // the entry keeps a's position + key (it stands for the group, not one row).
    expect(section!.entries.map((e) => e.row.id)).toEqual(["x", "b", "y"]);
    expect(section!.entries[1]!.key).toBe("a");
    expect(section!.entries[1]!.aggregateCount).toBe(2);
  });

  test("composes with group-by: collapses WITHIN each section independently", () => {
    interface Row {
      id: string;
      status: string;
      dup: string;
    }
    const statusField2: FieldDef<Row> = {
      id: "status",
      label: "S",
      type: "enum",
      value: (r) => r.status,
      options: [
        { value: "todo", label: "To do" },
        { value: "done", label: "Done" },
      ],
    };
    const rows: Row[] = [
      { id: "1", status: "todo", dup: "p" },
      { id: "2", status: "todo", dup: "p" },
      { id: "3", status: "done", dup: "p" },
    ];
    const grouped = partitionIntoSections(
      rows,
      [statusField2],
      by("status"),
      (r) => r.id,
      stubOpts({ enum: optionOrderGrouping }),
    );
    const aggregated = aggregateSections(grouped, { getKey: (r) => r.dup });
    expect(aggregated.map((s) => s.key)).toEqual(["todo", "done"]);
    // dup="p" collapses within each section separately — NOT across sections.
    expect(aggregated[0]!.entries).toHaveLength(1);
    expect(aggregated[0]!.entries[0]!.aggregateCount).toBe(2);
    expect(aggregated[0]!.count).toEqual({ kind: "exact", n: 1 });
    expect(aggregated[1]!.entries).toHaveLength(1);
    expect(aggregated[1]!.entries[0]!.aggregateCount).toBe(1);
  });

  test("aggregates the already-ordered entries (manual-rank composition): representative = first in current order", () => {
    // The hook applies the manual-rank sort BEFORE aggregateSections, so here we
    // simulate entries already ordered b, a, c and confirm the representative is
    // the first in that order (b), not the original input order.
    const section: DataViewSection<Item> = {
      key: null,
      count: { kind: "exact", n: 3 },
      entries: [
        { row: { id: "b", group: "g" }, key: "b" },
        { row: { id: "a", group: "g" }, key: "a" },
        { row: { id: "c", group: "g" }, key: "c" },
      ],
    };
    const [agg] = aggregateSections([section], { getKey: (i) => i.group });
    expect(agg!.entries).toHaveLength(1);
    expect(agg!.entries[0]!.row.id).toBe("b");
    expect(agg!.entries[0]!.members?.map((m) => m.id)).toEqual(["b", "a", "c"]);
  });
});

describe("orderSectionsByRank", () => {
  interface Ranked {
    id: string;
    rank: Rank | null;
  }
  const sectionOf = (
    key: string | null,
    entries: Ranked[],
  ): DataViewSection<Ranked> => ({
    key,
    count: { kind: "exact", n: entries.length },
    entries: entries.map((row) => ({ row, key: row.id })),
  });

  test("a ranked section sorts by rank, ignoring incoming order", () => {
    const [r0, r1, r2] = Rank.nBetween(null, null, 3);
    // Incoming order scrambled; expect rank-ascending output.
    const section = sectionOf(null, [
      { id: "c", rank: r2! },
      { id: "a", rank: r0! },
      { id: "b", rank: r1! },
    ]);
    const [out] = orderSectionsByRank([section], (r) => r.rank);
    expect(out!.entries.map((e) => e.row.id)).toEqual(["a", "b", "c"]);
  });

  test("an all-null section keeps incoming order (stable no-op)", () => {
    const section = sectionOf(null, [
      { id: "x", rank: null },
      { id: "y", rank: null },
      { id: "z", rank: null },
    ]);
    const [out] = orderSectionsByRank([section], (r) => r.rank);
    expect(out!.entries.map((e) => e.row.id)).toEqual(["x", "y", "z"]);
  });

  test("orders each homogeneous section independently (ranked sorts, null keeps order)", () => {
    const [r0, r1] = Rank.nBetween(null, null, 2);
    const ranked = sectionOf("ranked", [
      { id: "b", rank: r1! },
      { id: "a", rank: r0! },
    ]);
    const nulls = sectionOf("nulls", [
      { id: "n1", rank: null },
      { id: "n2", rank: null },
    ]);
    const out = orderSectionsByRank([ranked, nulls], (r) => r.rank);
    expect(out[0]!.entries.map((e) => e.row.id)).toEqual(["a", "b"]);
    expect(out[1]!.entries.map((e) => e.row.id)).toEqual(["n1", "n2"]);
  });
});

describe("isGroupableField", () => {
  test("the default follows the INJECTED predicate, not any type list", () => {
    // Exactly the app's shipped answer for enum/bool/number, reached by asking
    // which types declare a grouping rather than by naming them here.
    const hasGrouping = hasGroupingIn("enum", "bool", "date");
    expect(isGroupableField(statusField, hasGrouping)).toBe(true);
    expect(
      isGroupableField(
        { id: "f", label: "Flag", type: "bool", value: () => true },
        hasGrouping,
      ),
    ).toBe(true);
    expect(
      isGroupableField(
        { id: "d", label: "When", type: "date", value: () => new Date() },
        hasGrouping,
      ),
    ).toBe(true);
    expect(
      isGroupableField(
        { id: "n", label: "N", type: "number", value: () => 1 },
        hasGrouping,
      ),
    ).toBe(false);
  });

  test("a `data`-only field is refused, even when it asks to be groupable", () => {
    // `data` is display-only: with no comparable `value` there is nothing to
    // bucket, whatever the flag or the type's registry answer says.
    expect(
      isGroupableField(
        {
          id: "avatar",
          label: "Avatar",
          type: "spec",
          data: () => ({ glyph: "★" }),
          groupable: true,
        },
        hasGroupingIn("spec"),
      ),
    ).toBe(false);
  });

  test("a type that declares no grouping is not groupable by default", () => {
    // The same enum field, against a registry where nothing is registered —
    // proof that the answer comes from the predicate and nowhere else.
    expect(isGroupableField(statusField, hasGroupingIn())).toBe(false);
  });

  test("explicit groupable overrides the predicate; value-less is never groupable", () => {
    expect(
      isGroupableField(
        {
          id: "n",
          label: "N",
          type: "number",
          value: () => 1,
          groupable: true,
        },
        hasGroupingIn(),
      ),
    ).toBe(true);
    expect(
      isGroupableField(
        {
          id: "e",
          label: "E",
          type: "enum",
          value: () => "x",
          groupable: false,
        },
        hasGroupingIn("enum"),
      ),
    ).toBe(false);
    expect(
      isGroupableField(
        { id: "e", label: "E", type: "enum", groupable: true },
        hasGroupingIn("enum"),
      ),
    ).toBe(false);
  });

  test("an untyped field defaults to `text`", () => {
    expect(
      isGroupableField(
        { id: "t", label: "T", value: () => "x" },
        hasGroupingIn("text"),
      ),
    ).toBe(true);
  });
});

describe("the identity grouping (the built-in fallback)", () => {
  test("reproduces today's enum-ish output: one section per value, value order", () => {
    const rows: Task[] = [
      { id: "1", status: "todo" },
      { id: "2", status: "doing" },
      { id: "3", status: "todo" },
      { id: "4", status: "done" },
    ];
    const sections = partitionIntoSections(
      rows,
      [statusField],
      by("status"),
      rowKey,
      stubOpts(),
    );
    // Value-sorted (the pre-grouping default for a non-enum field), labelled by
    // the stored value — an enum's option labels/order now come from the enum
    // type's own contribution, not from here.
    expect(sections.map((s) => s.key)).toEqual(["doing", "done", "todo"]);
    expect(sections.map((s) => s.label)).toEqual(["doing", "done", "todo"]);
    expect(sections.map((s) => s.count.n)).toEqual([1, 1, 2]);
    expect(sections[2]!.entries.map((e) => e.key)).toEqual(["1", "3"]);
  });

  test("reproduces today's bool-ish output: false before true", () => {
    interface Flag {
      id: string;
      on: boolean;
    }
    const onField: FieldDef<Flag> = {
      id: "on",
      label: "On",
      type: "bool",
      value: (f) => f.on,
    };
    const rows: Flag[] = [
      { id: "1", on: true },
      { id: "2", on: false },
      { id: "3", on: true },
    ];
    const sections = partitionIntoSections(
      rows,
      [onField],
      by("on"),
      (f) => f.id,
      stubOpts(),
    );
    // `compareValues` maps boolean → 0/1, so false sorts first — the ordering
    // the old hardcoded Yes/No branch produced. (The Yes/No LABELS are the bool
    // type's own contribution now.)
    expect(sections.map((s) => s.key)).toEqual(["false", "true"]);
    expect(sections.map((s) => s.count.n)).toEqual([1, 2]);
  });

  test("its ordinal is monotonic across duplicates and reverses cleanly", () => {
    const rows: Task[] = [
      { id: "1", status: "c" },
      { id: "2", status: "a" },
      { id: "3", status: "a" },
      { id: "4", status: "b" },
    ];
    const asc = partitionIntoSections(
      rows,
      [statusField],
      by("status"),
      rowKey,
      stubOpts(),
    );
    const desc = partitionIntoSections(
      rows,
      [statusField],
      by("status"),
      rowKey,
      stubOpts({}, "desc"),
    );
    expect(asc.map((s) => s.key)).toEqual(["a", "b", "c"]);
    expect(desc.map((s) => s.key)).toEqual(["c", "b", "a"]);
  });
});

describe("a server-ordered rows set: section order and counts", () => {
  // Rows as a live source returns them under a one-bucket-per-value grouping:
  // sorted by the grouped column's STORED value (done < doing < todo), which
  // is not the enum's options order (todo, doing, done).
  const sorted: Task[] = [
    { id: "1", status: "doing" },
    { id: "2", status: "done" },
    { id: "3", status: "done" },
    { id: "4", status: "todo" },
    { id: "5", status: null },
  ];

  test("sections follow first appearance in the rows, not the bucket ordinal — None still trails", () => {
    const sections = partitionIntoSections(
      sorted,
      [statusField],
      by("status"),
      rowKey,
      {
        ...stubOpts({ enum: optionOrderGrouping }),
        sectioning: { kind: "appearance" },
        rowsComplete: false,
      },
    );
    expect(sections.map((s) => s.label)).toEqual([
      "Doing",
      "Done",
      "To do",
      "None",
    ]);
    // A section a later one follows is complete; the last may still grow.
    expect(sections.map((s) => s.count)).toEqual([
      { kind: "exact", n: 1 },
      { kind: "exact", n: 2 },
      { kind: "exact", n: 1 },
      { kind: "atLeast", n: 1 },
    ]);
  });

  test("once every row is loaded, every count is exact", () => {
    const sections = partitionIntoSections(
      sorted,
      [statusField],
      by("status"),
      rowKey,
      {
        ...stubOpts({ enum: optionOrderGrouping }),
        sectioning: { kind: "appearance" },
        rowsComplete: true,
      },
    );
    expect(sections.every((s) => s.count.kind === "exact")).toBe(true);
  });

  test("a bucketed grouping keeps its ordinal order, and while rows may still load no count is a total", () => {
    const sections = partitionIntoSections(
      sorted,
      [statusField],
      by("status"),
      rowKey,
      {
        ...stubOpts({ enum: optionOrderGrouping }),
        sectioning: { kind: "bucket" },
        rowsComplete: false,
      },
    );
    // The options order — To do, Doing, Done — as in memory.
    expect(sections.map((s) => s.label)).toEqual([
      "To do",
      "Doing",
      "Done",
      "None",
    ]);
    expect(sections.every((s) => s.count.kind === "atLeast")).toBe(true);
  });

  test("ungrouped: one section, exact only when complete", () => {
    const [partial] = partitionIntoSections(
      sorted,
      [statusField],
      undefined,
      rowKey,
      { ...stubOpts<Task>(), rowsComplete: false },
    );
    expect(partial!.count).toEqual({ kind: "atLeast", n: 5 });
    const [whole] = partitionIntoSections(
      sorted,
      [statusField],
      undefined,
      rowKey,
      stubOpts(),
    );
    expect(whole!.count).toEqual({ kind: "exact", n: 5 });
  });

  test("the formatter prints a lower bound as n+", () => {
    expect(formatSectionCount({ kind: "exact", n: 3 })).toBe("3");
    expect(formatSectionCount({ kind: "atLeast", n: 3 })).toBe("3+");
  });
});

describe("partitionIntoSections — a paged read's known total", () => {
  // Rows 1–3 are held in memory; 4–5 are the loaded prefix of a paged read
  // (every one "done") that holds 40 rows in all.
  const rows: Task[] = [
    { id: "1", status: "todo" },
    { id: "2", status: "doing" },
    { id: "3", status: "done" },
    { id: "4", status: "done" },
    { id: "5", status: "done" },
  ];
  const growable = (t: Task) => Number(t.id) >= 4;
  const opts = (
    total: { count: number; uniform?: readonly string[] } | null,
  ): PartitionOptions<Task> => ({
    ...stubOpts({ enum: optionOrderGrouping }),
    rowsComplete: { growable, total },
  });

  test("ungrouped: the held rows plus the read's total", () => {
    const [only] = partitionIntoSections(
      rows,
      [statusField],
      undefined,
      rowKey,
      opts({ count: 40 }),
    );
    expect(only!.count).toEqual({ kind: "exact", n: 43 });
  });

  test("grouped by a uniform field: the section holding the read counts its total, the others stay exact", () => {
    const sections = partitionIntoSections(
      rows,
      [statusField],
      by("status"),
      rowKey,
      opts({ count: 40, uniform: ["status"] }),
    );
    expect(sections.map((s) => [s.label, s.count])).toEqual([
      ["To do", { kind: "exact", n: 1 }],
      ["Doing", { kind: "exact", n: 1 }],
      // Row 3 (held) + the read's 40.
      ["Done", { kind: "exact", n: 41 }],
    ]);
  });

  test("grouped by a field the read does not share: a lower bound", () => {
    const sections = partitionIntoSections(
      rows,
      [statusField],
      by("status"),
      rowKey,
      opts({ count: 40 }),
    );
    expect(sections.find((s) => s.label === "Done")!.count).toEqual({
      kind: "atLeast",
      n: 3,
    });
  });

  test("the read's loaded rows split across sections: a lower bound everywhere they are", () => {
    const split: Task[] = [
      { id: "4", status: "todo" },
      { id: "5", status: "done" },
    ];
    const sections = partitionIntoSections(
      split,
      [statusField],
      by("status"),
      rowKey,
      opts({ count: 40, uniform: ["status"] }),
    );
    expect(sections.every((s) => s.count.kind === "atLeast")).toBe(true);
  });

  test("no total (unknown, or a search hides rows of the read): a lower bound", () => {
    const [only] = partitionIntoSections(
      rows,
      [statusField],
      undefined,
      rowKey,
      opts(null),
    );
    expect(only!.count).toEqual({ kind: "atLeast", n: 5 });
  });

  test("a total behind the rows loaded (a write ago) never counts below them", () => {
    const [only] = partitionIntoSections(
      rows,
      [statusField],
      undefined,
      rowKey,
      opts({ count: 1 }),
    );
    expect(only!.count).toEqual({ kind: "exact", n: 5 });
  });
});

describe("aggregateSections — a count covering unloaded rows", () => {
  const section = (n: number, ids: string[]): DataViewSection<Task> => ({
    key: "done",
    label: "Done",
    count: { kind: "exact", n },
    entries: ids.map((id) => ({ row: { id, status: "done" }, key: id })),
  });

  test("nothing collapses: the unloaded rows stay counted", () => {
    const [s] = aggregateSections([section(40, ["a", "b"])], {
      getKey: () => null,
    });
    expect(s!.count).toEqual({ kind: "exact", n: 40 });
  });

  test("loaded rows collapse: the unloaded may too, so only the entries seen are known", () => {
    const [s] = aggregateSections([section(40, ["a", "b"])], {
      getKey: () => "same",
    });
    expect(s!.count).toEqual({ kind: "atLeast", n: 1 });
  });
});

describe("declared sections (a server-sectioned live source)", () => {
  const paging = (complete: boolean): DataViewSectionPaging => ({
    canGrow: !complete,
    growing: false,
    loadMore: () => {},
    complete,
    stalled: null,
    truncated: false,
    notices: [],
    viewport: { report: () => {} },
    placeholders: { before: [], after: [] },
  });
  const declared: DataViewSectioning<Task> = {
    kind: "declared",
    sections: [
      {
        key: "doing",
        label: "Doing",
        count: 4,
        rows: [
          { id: "1", status: "doing" },
          { id: "2", status: "doing" },
        ],
        paging: paging(false),
      },
      // Not read yet: listed anyway, with its count and its paging.
      { key: "done", label: "Done", count: 9, rows: [], paging: paging(false) },
      {
        key: NULL_GROUP_KEY,
        label: "None",
        count: 1,
        rows: [{ id: "3", status: null }],
        paging: paging(true),
      },
    ],
  };

  test("every declared section, in its order, with the server's exact count — empty ones too", () => {
    const sections = partitionIntoSections(
      // The rows argument is not read: each section brings its own.
      [],
      [statusField],
      by("status"),
      rowKey,
      {
        ...stubOpts<Task>({ enum: optionOrderGrouping }),
        sectioning: declared,
      },
    );
    expect(sections.map((s) => [s.key, s.label, s.count])).toEqual([
      ["doing", "Doing", { kind: "exact", n: 4 }],
      ["done", "Done", { kind: "exact", n: 9 }],
      [NULL_GROUP_KEY, "None", { kind: "exact", n: 1 }],
    ]);
    expect(sections.map((s) => s.entries.map((e) => e.key))).toEqual([
      ["1", "2"],
      [],
      ["3"],
    ]);
    expect(sections.map((s) => s.paging?.complete)).toEqual([
      false,
      false,
      true,
    ]);
  });

  // The paged-total rule: a section whose loaded rows collapsed is a lower
  // bound (its unloaded rows may collapse too); one with nothing collapsed
  // keeps the server's count for its unloaded rows.
  test("an aggregate over a section still paging: collapsed is a lower bound, else the server's count", () => {
    const sections = aggregateSections(
      partitionIntoSections([], [statusField], by("status"), rowKey, {
        ...stubOpts<Task>(),
        sectioning: declared,
      }),
      { getKey: () => "same" },
    );
    expect(sections.map((s) => s.count)).toEqual([
      { kind: "atLeast", n: 1 },
      { kind: "exact", n: 9 },
      { kind: "exact", n: 1 },
    ]);
  });

  test("a section whose loaded tail is folded stops paging until its line opens", () => {
    const sections = partitionIntoSections(
      [],
      [statusField],
      by("status"),
      rowKey,
      { ...stubOpts<Task>(), sectioning: declared },
    );
    const keepFirst = (entries: readonly { key: string }[]) =>
      entries.map((entry) => entry.key === "1");
    const [closed] = foldSections(sections, {
      keep: keepFirst,
      openKeys: new Set(),
    });
    expect(closed!.paging?.canGrow).toBe(false);
    const [open] = foldSections(sections, {
      keep: keepFirst,
      openKeys: new Set(["doing"]),
    });
    expect(open!.paging?.canGrow).toBe(true);
  });
});

// ── Nested sections ────────────────────────────────────────────────────────
//
// A grouping whose buckets carry `ancestors` (a forest of options) — written as
// a stub so the suite proves the MECHANISM without naming the `tag` type.

interface Proto {
  id: string;
  tag: string | null;
}

// app ▸ website ▸ homepage, app ▸ chord; infra ▸ data-view; theme — in tree
// order, so an option's index is its ordinal among its siblings too.
const TAGS = [
  { value: "app", label: "app" },
  { value: "website", label: "website", parent: "app" },
  { value: "homepage", label: "homepage", parent: "website" },
  { value: "chord", label: "chord", parent: "app" },
  { value: "infra", label: "infra" },
  { value: "data-view", label: "data-view", parent: "infra" },
  { value: "theme", label: "theme" },
];

const swatchOf = (key: string) => (key === "app" ? { swatch: "#7c5cff" } : {});

const forestGrouping: FieldGrouping = {
  id: "tree",
  label: "Nested",
  plan: ({ field }) => {
    const options = field.options ?? [];
    const index = new Map(options.map((o, i) => [o.value, i]));
    const ancestorsOf = (key: string) => {
      const chain = [];
      for (
        let up = options[index.get(key)!]!.parent;
        up !== undefined;
        up = options[index.get(up)!]!.parent
      ) {
        chain.unshift({
          key: up,
          label: up,
          order: index.get(up)!,
          ...swatchOf(up),
        });
      }
      return chain;
    };
    return (value) => {
      const key = String(value);
      if (!index.has(key)) return null;
      const ancestors = ancestorsOf(key);
      return {
        key,
        label: key,
        order: index.get(key)!,
        ...swatchOf(key),
        ...(ancestors.length ? { ancestors } : {}),
      };
    };
  },
};

const tagField: FieldDef<Proto> = {
  id: "tag",
  label: "Tag",
  type: "tag",
  options: TAGS,
  value: (p) => p.tag,
};

const nestedOpts = (
  extra: Partial<PartitionOptions<Proto>> = {},
): PartitionOptions<Proto> => ({
  ...stubOpts<Proto>({ tag: forestGrouping }),
  ...extra,
});

const protoKey = (p: Proto) => p.id;

/** `[key, depth, parentKey, own entry ids, count]` per section — the shape a
 *  reader sees, in emission order. */
const shape = (sections: DataViewSection<Proto>[]) =>
  sections.map((s) => [
    s.key,
    s.nesting?.depth ?? null,
    s.nesting?.parentKey ?? null,
    s.entries.map((e) => e.row.id),
    formatSectionCount(s.count),
  ]);

const PROTOS: Proto[] = [
  { id: "p1", tag: "homepage" },
  { id: "p2", tag: "app" },
  { id: "p3", tag: "chord" },
  { id: "p4", tag: null },
  { id: "p5", tag: "data-view" },
  { id: "p6", tag: "homepage" },
  { id: "p7", tag: "gone" },
];

describe("partitionIntoSections — nested buckets", () => {
  test("emits tree order (pre-order) with depth, ancestors as sections with no own rows, None last", () => {
    const sections = partitionIntoSections(
      PROTOS,
      [tagField],
      by("tag", "tree"),
      protoKey,
      nestedOpts(),
    );
    // Counts are OWN rows here — the roll-up runs last in the pipeline.
    expect(shape(sections)).toEqual([
      ["app", 0, null, ["p2"], "1"],
      ["website", 1, "app", [], "0"],
      ["homepage", 2, "website", ["p1", "p6"], "2"],
      ["chord", 1, "app", ["p3"], "1"],
      ["infra", 0, null, [], "0"],
      ["data-view", 1, "infra", ["p5"], "1"],
      // No row is tagged "theme": a subtree with no rows is never emitted.
      // An unknown tag joins the null value in the ONE None, at the top level.
      [NULL_GROUP_KEY, null, null, ["p4", "p7"], "2"],
    ]);
    expect(sections[0]!.identity).toEqual({ swatch: "#7c5cff" });
    expect(sections[1]!.identity).toBeUndefined();
  });

  test("desc reverses each sibling level, children still under their parent, None still last", () => {
    const sections = partitionIntoSections(
      PROTOS,
      [tagField],
      by("tag", "tree"),
      protoKey,
      nestedOpts({ order: "desc" }),
    );
    expect(sections.map((s) => s.key)).toEqual([
      "infra",
      "data-view",
      "app",
      "chord",
      "website",
      "homepage",
      NULL_GROUP_KEY,
    ]);
  });

  test("`flat` (the nested table) and `appearance` sectioning ignore ancestors", () => {
    for (const extra of [
      { flat: true },
      { sectioning: { kind: "appearance" } as const },
    ]) {
      const sections = partitionIntoSections(
        PROTOS,
        [tagField],
        by("tag", "tree"),
        protoKey,
        nestedOpts(extra),
      );
      expect(sections.every((s) => s.nesting === undefined)).toBe(true);
      expect(sections.map((s) => s.key)).not.toContain("website");
    }
  });

  test("two different ancestor chains for one bucket throw, naming the grouping", () => {
    const flaky: FieldGrouping = {
      id: "flaky",
      label: "Flaky",
      plan: () => (value) =>
        value === "x"
          ? {
              key: "x",
              label: "x",
              order: 0,
              ancestors: [{ key: "a", label: "a", order: 0 }],
            }
          : {
              key: "y",
              label: "y",
              order: 1,
              ancestors: [
                { key: "x", label: "x", order: 0 },
                { key: "a", label: "a", order: 9 },
              ],
            },
    };
    expect(() =>
      partitionIntoSections(
        [
          { id: "1", tag: "x" },
          { id: "2", tag: "y" },
        ],
        [tagField],
        by("tag", "flaky"),
        protoKey,
        stubOpts<Proto>({ "tag:flaky": flaky }),
      ),
    ).toThrow(/"flaky".*"a"|"flaky".*"x"/);
  });
});

describe("rollUpNestedCounts", () => {
  const partition = (
    rows: Proto[],
    extra: Partial<PartitionOptions<Proto>> = {},
  ) =>
    partitionIntoSections(
      rows,
      [tagField],
      by("tag", "tree"),
      protoKey,
      nestedOpts(extra),
    );

  test("a nested section counts its whole subtree; None and flat sections are untouched", () => {
    const rolled = rollUpNestedCounts(partition(PROTOS));
    expect(rolled.map((s) => [s.key, formatSectionCount(s.count)])).toEqual([
      ["app", "4"],
      ["website", "2"],
      ["homepage", "2"],
      ["chord", "1"],
      ["infra", "1"],
      ["data-view", "1"],
      [NULL_GROUP_KEY, "2"],
    ]);
    // Entries stay each section's OWN rows.
    expect(rolled[0]!.entries.map((e) => e.row.id)).toEqual(["p2"]);
  });

  test("a lower bound anywhere below makes every ancestor's count a lower bound", () => {
    const growable = (p: Proto) => p.id === "p1";
    const rolled = rollUpNestedCounts(
      partition(PROTOS, { rowsComplete: { growable, total: null } }),
    );
    const count = (key: string) =>
      formatSectionCount(rolled.find((s) => s.key === key)!.count);
    expect(count("homepage")).toBe("2+");
    expect(count("website")).toBe("2+");
    expect(count("app")).toBe("4+");
    expect(count("chord")).toBe("1");
    expect(count("infra")).toBe("1");
  });

  test("is a no-op without nesting", () => {
    const flat = partitionIntoSections(
      [{ id: "1", status: "todo" }] as Task[],
      [statusField],
      by("status"),
      rowKey,
      stubOpts({ enum: optionOrderGrouping }),
    );
    expect(rollUpNestedCounts(flat)).toBe(flat);
  });

  test("runs after aggregate and fold: a parent counts what its children's headers say", () => {
    const rows: Proto[] = [
      { id: "a1", tag: "app" },
      { id: "h1", tag: "homepage" },
      { id: "h2", tag: "homepage" },
      { id: "h3", tag: "homepage" },
    ];
    // h1 + h2 collapse into one aggregate entry; the fold hides a1 (count kept).
    let sections = partition(rows);
    sections = aggregateSections(sections, {
      getKey: (p) => (p.id === "h1" || p.id === "h2" ? "pair" : null),
    });
    sections = foldSections(sections, {
      keep: (entries) => entries.map((e) => e.row.id !== "a1"),
      openKeys: new Set(),
    });
    const rolled = rollUpNestedCounts(sections);
    expect(rolled.map((s) => [s.key, formatSectionCount(s.count)])).toEqual([
      ["app", "3"], // its own 1 (folded, still counted) + homepage's 2 entries
      ["website", "2"],
      ["homepage", "2"],
    ]);
    expect(rolled[0]!.fold).toEqual({ hidden: 1, open: false });
  });
});

describe("sumSectionCounts", () => {
  test("exact only when every part is; no parts is an exact zero", () => {
    expect(sumSectionCounts([])).toEqual({ kind: "exact", n: 0 });
    expect(
      sumSectionCounts([
        { kind: "exact", n: 2 },
        { kind: "exact", n: 3 },
      ]),
    ).toEqual({ kind: "exact", n: 5 });
    expect(
      sumSectionCounts([
        { kind: "exact", n: 2 },
        { kind: "atLeast", n: 3 },
      ]),
    ).toEqual({ kind: "atLeast", n: 5 });
  });
});

describe("visibleSections", () => {
  const sections = partitionIntoSections(
    PROTOS,
    [tagField],
    by("tag", "tree"),
    protoKey,
    nestedOpts(),
  );
  const keys = (collapsed: string[]) =>
    visibleSections(sections, new Set(collapsed)).map((s) => s.key);

  test("a collapsed section keeps its header but hides every descendant", () => {
    expect(keys(["app"])).toEqual([
      "app",
      "infra",
      "data-view",
      NULL_GROUP_KEY,
    ]);
  });

  test("each level folds on its own", () => {
    expect(keys(["website"])).toEqual([
      "app",
      "website",
      "chord",
      "infra",
      "data-view",
      NULL_GROUP_KEY,
    ]);
    // Reopening the parent shows the child still folded.
    expect(keys(["app", "website"])).toEqual(keys(["app"]));
  });

  test("nothing collapsed, or flat sections: everything stays", () => {
    expect(keys([])).toEqual(sections.map((s) => s.key));
    const flat = [{ key: "a" }, { key: "b" }];
    expect(visibleSections(flat, new Set(["a"]))).toEqual(flat);
  });
});

describe("a section's identity (its value's glyph and colour)", () => {
  const icon = symbol("list");
  // A grouping that copies a bucket identity for "doing" only.
  const identityGrouping: FieldGrouping = {
    id: "value",
    label: "Value",
    plan: () => (value) => {
      const key = String(value);
      return key === "doing"
        ? { key, label: "Doing", order: 0, icon, tint: "--categorical-3" }
        : { key, label: key, order: 1 };
    },
  };
  const tasks: Task[] = [
    { id: "1", status: "doing" },
    { id: "2", status: "todo" },
    { id: "3", status: null },
  ];

  test("reaches the section from its bucket; absent when the bucket has none", () => {
    const sections = partitionIntoSections(
      tasks,
      [statusField],
      by("status"),
      rowKey,
      stubOpts<Task>({ enum: identityGrouping }),
    );
    expect(sections.map((s) => s.key)).toEqual([
      "doing",
      "todo",
      NULL_GROUP_KEY,
    ]);
    expect(sections[0]!.identity).toEqual({ icon, tint: "--categorical-3" });
    // No identity key at all — not an empty object a header could test.
    expect("identity" in sections[1]!).toBe(false);
    expect("identity" in sections[2]!).toBe(false);
  });

  test("a declared section carries the identity the server path gave it", () => {
    const [section] = partitionIntoSections(
      [],
      [statusField],
      by("status"),
      rowKey,
      {
        ...stubOpts<Task>({ enum: identityGrouping }),
        sectioning: {
          kind: "declared",
          sections: [
            {
              key: "doing",
              label: "Doing",
              identity: { icon },
              count: 0,
              rows: [],
              paging: {
                canGrow: false,
                growing: false,
                loadMore: () => {},
                complete: true,
                stalled: null,
                truncated: false,
                notices: [],
                viewport: { report: () => {} },
                placeholders: { before: [], after: [] },
              },
            },
          ],
        },
      },
    );
    expect(section!.identity).toEqual({ icon });
  });
});
