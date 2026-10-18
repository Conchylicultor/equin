import { describe, expect, it } from "bun:test";
import { clause } from "@plugins/network/plugins/live/plugins/filter/core";
import {
  applyFilter,
  coerceToDomain,
  lowerFilterGroup,
} from "./evaluate-filter";
import type {
  FieldDef,
  FilterGroup,
  FilterNode,
  FilterOperatorSet,
} from "../../core";

interface Row {
  name: string;
  age: number;
  at: Date | null;
}

const fields: FieldDef<Row>[] = [
  { id: "name", label: "Name", type: "text", value: (r) => r.name },
  { id: "age", label: "Age", type: "number", value: (r) => r.age },
  { id: "at", label: "At", type: "stamp", value: (r) => r.at },
];

// Minimal operator sets: text "contains", number ">", and a clock-reading
// "stamp · after now" that proves `readsClock` without naming the date type.
const sets: Record<string, FilterOperatorSet> = {
  text: {
    match: "text",
    domain: "text",
    operators: [
      {
        id: "contains",
        label: "Contains",
        hasValue: true,
        lower: (op, { column }) =>
          typeof op === "string" && op !== ""
            ? clause(column, "contains", op)
            : undefined,
      },
    ],
  },
  number: {
    match: "number",
    domain: "number",
    operators: [
      {
        id: ">",
        label: ">",
        hasValue: true,
        lower: (op, { column }) =>
          typeof op === "number" ? clause(column, "gt", op) : undefined,
      },
    ],
  },
  stamp: {
    match: "stamp",
    domain: "instant",
    operators: [
      {
        id: "after-now",
        label: "After now",
        hasValue: false,
        lower: (_op, ctx) =>
          clause(ctx.column, "gt", new Date(ctx.now).toISOString()),
      },
    ],
  },
};

const resolve = (typeId: string): FilterOperatorSet | undefined => sets[typeId];

const rule = (fieldId: string, operatorId: string, value?: unknown) =>
  ({
    kind: "rule",
    id: `${fieldId}-${operatorId}`,
    fieldId,
    operatorId,
    value,
  }) as const;

const group = (
  conjunction: "and" | "or",
  children: FilterGroup["children"],
): FilterGroup => ({ kind: "group", id: "g", conjunction, children });

const ann: Row = { name: "Annie", age: 40, at: new Date(2_000) };
const bob: Row = { name: "Bob", age: 10, at: null };

/** Does the tree keep `row`? — the in-memory evaluator's whole path. */
function keeps(node: FilterNode, row: Row, now = 0): boolean {
  const g = node.kind === "group" ? node : group("and", [node]);
  return applyFilter([row], g, fields, resolve, now).length === 1;
}

describe("in-memory evaluation (lower → matchesFilter)", () => {
  it("empty group → true", () => {
    expect(keeps(group("and", []), ann)).toBe(true);
    expect(keeps(group("or", []), ann)).toBe(true);
  });

  it("AND requires every child", () => {
    const g = group("and", [
      rule("name", "contains", "ann"),
      rule("age", ">", 20),
    ]);
    expect(keeps(g, ann)).toBe(true);
    expect(keeps(g, bob)).toBe(false); // fails both
  });

  it("OR requires some child", () => {
    const g = group("or", [
      rule("name", "contains", "ann"),
      rule("age", ">", 20),
    ]);
    expect(keeps(g, ann)).toBe(true);
    expect(keeps(g, bob)).toBe(false); // fails both
    // bob matches via name OR
    const g2 = group("or", [
      rule("name", "contains", "bob"),
      rule("age", ">", 99),
    ]);
    expect(keeps(g2, bob)).toBe(true);
  });

  it("nests groups", () => {
    const g = group("and", [
      rule("name", "contains", "b"),
      group("or", [rule("age", ">", 100), rule("age", ">", 5)]),
    ]);
    expect(keeps(g, bob)).toBe(true); // name has b, age>5
  });

  it("missing field → rule is a no-op (true)", () => {
    expect(keeps(group("and", [rule("nope", "contains", "x")]), ann)).toBe(
      true,
    );
  });

  it("missing operator → rule is a no-op (true)", () => {
    expect(keeps(group("and", [rule("name", "no-such-op", "x")]), ann)).toBe(
      true,
    );
  });

  it("unresolved operator set → rule is a no-op (true)", () => {
    const g = group("and", [rule("name", "contains", "zzz")]);
    expect(applyFilter([ann], g, fields, () => undefined, 0)).toEqual([ann]);
  });

  it("an incomplete child makes an OR a no-op, and drops out of an AND", () => {
    const orG = group("or", [rule("age", ">", 99), rule("name", "contains")]);
    expect(keeps(orG, bob)).toBe(true);
    const andG = group("and", [rule("age", ">", 99), rule("name", "contains")]);
    expect(keeps(andG, bob)).toBe(false);
  });
});

describe("lowerFilterGroup", () => {
  it("lowers each rule over its field id, flattening one-child groups", () => {
    const g = group("and", [
      rule("name", "contains", "ann"),
      group("or", [rule("age", ">", 20)]),
    ]);
    expect(lowerFilterGroup(g, fields, resolve, 0)).toEqual({
      filter: {
        and: [
          { column: "name", op: "contains", operand: "ann" },
          { column: "age", op: "gt", operand: 20 },
        ],
      },
      readsClock: false,
      unavailable: [],
    });
  });

  it("a tree with nothing complete is the absent filter", () => {
    expect(
      lowerFilterGroup(
        group("and", [rule("name", "contains", "")]),
        fields,
        resolve,
        0,
      ),
    ).toEqual({ filter: undefined, readsClock: false, unavailable: [] });
    expect(lowerFilterGroup(null, fields, resolve, 0).filter).toBeUndefined();
  });

  it("reports readsClock when a rule read ctx.now, and lowers at that now", () => {
    const g = group("and", [rule("at", "after-now")]);
    const lowered = lowerFilterGroup(g, fields, resolve, 1_000);
    expect(lowered.readsClock).toBe(true);
    expect(keeps(g, ann, 1_000)).toBe(true);
    expect(keeps(g, ann, 5_000)).toBe(false);
  });
});

describe("coerceToDomain (the one DataView-side adapter)", () => {
  it("text: arrays join, Date is ISO, others stringify", () => {
    expect(coerceToDomain(["a", "b"], "text")).toBe("a b");
    expect(coerceToDomain(new Date(0), "text")).toBe(
      "1970-01-01T00:00:00.000Z",
    );
    expect(coerceToDomain(5, "text")).toBe("5");
    expect(coerceToDomain(undefined, "text")).toBe(null);
  });

  it("number: finite or NULL", () => {
    expect(coerceToDomain(3, "number")).toBe(3);
    expect(coerceToDomain(Number.NaN, "number")).toBe(null);
    expect(coerceToDomain("3", "number")).toBe(null);
  });

  it("boolean: truthiness, NULL when absent", () => {
    expect(coerceToDomain(1, "boolean")).toBe(true);
    expect(coerceToDomain("", "boolean")).toBe(false);
    expect(coerceToDomain(null, "boolean")).toBe(null);
  });

  it("instant: Date / epoch ms / parseable string → Date, else NULL", () => {
    expect(coerceToDomain(new Date(7), "instant")).toEqual(new Date(7));
    expect(coerceToDomain(7, "instant")).toEqual(new Date(7));
    expect(coerceToDomain("1970-01-01T00:00:00.007Z", "instant")).toEqual(
      new Date(7),
    );
    expect(coerceToDomain("nope", "instant")).toBe(null);
    expect(coerceToDomain("", "instant")).toBe(null);
  });

  it("stringArray: the array, else NULL", () => {
    expect(coerceToDomain(["a"], "stringArray")).toEqual(["a"]);
    expect(coerceToDomain("a", "stringArray")).toBe(null);
  });
});

describe("lowerFilterGroup — unavailable rules", () => {
  it("reports every rule that does not resolve, by id, at any depth", () => {
    // The `or` is TRUE from its first (dangling) child — the later dangling
    // rule is still reported, so removing the first cannot reveal a second.
    const g = group("and", [
      rule("name", "contains", "ann"),
      group("or", [
        rule("gone", "contains", "x"),
        rule("name", "no-such-op", "x"),
      ]),
    ]);
    expect(lowerFilterGroup(g, fields, resolve, 0).unavailable).toEqual([
      { id: "gone-contains", fieldId: "gone", operatorId: "contains" },
      { id: "name-no-such-op", fieldId: "name", operatorId: "no-such-op" },
    ]);
  });

  it("an incomplete rule is not unavailable — it constrains nothing, as authored", () => {
    const g = group("and", [rule("name", "contains")]);
    expect(lowerFilterGroup(g, fields, resolve, 0).unavailable).toEqual([]);
  });
});
