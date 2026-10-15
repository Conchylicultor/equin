import { describe, expect, it } from "bun:test";
import {
  FilterError,
  clause,
  liveText,
  or,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { liveNumber } from "@plugins/network/plugins/live/plugins/filter/core/testing";
import type {
  FieldDef,
  FilterGroup,
  FilterOperatorSet,
  FilterRule,
} from "../../core";
import {
  lowerSearch,
  lowerViewFilter,
  UnavailableFilterRuleError,
} from "./live-filter";

type Row = Record<string, unknown>;

const textSet: FilterOperatorSet = {
  match: "text",
  domain: "text",
  operators: [
    {
      id: "contains",
      label: "Contains",
      hasValue: true,
      lower: (operand, { column }) =>
        typeof operand === "string" && operand !== ""
          ? clause(column, "contains", operand)
          : undefined,
    },
  ],
};

const numberSet: FilterOperatorSet = {
  match: "number",
  domain: "number",
  operators: [
    {
      id: "gt",
      label: ">",
      hasValue: true,
      lower: (operand, { column }) =>
        typeof operand === "number" ? clause(column, "gt", operand) : undefined,
    },
  ],
};

const resolve = (typeId: string): FilterOperatorSet | undefined =>
  [textSet, numberSet].find((s) => s.match === typeId);

const fields: FieldDef<Row>[] = [
  { id: "title", label: "Title", type: "text" },
  { id: "note", label: "Note", type: "text" }, // not declared by the source
  { id: "score", label: "Score", type: "number" },
];

const rule = (
  fieldId: string,
  operatorId: string,
  value: unknown,
): FilterRule => ({
  kind: "rule",
  id: `r-${fieldId}-${String(value)}`,
  fieldId,
  operatorId,
  value,
});

const group = (...children: FilterGroup["children"]): FilterGroup => ({
  kind: "group",
  id: "g",
  conjunction: "and",
  children,
});

describe("lowerSearch", () => {
  const filterable = { title: liveText(), body: liveText(), n: liveNumber() };

  it("blank is no filter", () => {
    expect(lowerSearch("   ", ["title"], filterable)).toBeUndefined();
  });

  it("lowers to an OR of contains over the searchable columns, trimmed", () => {
    expect(lowerSearch("  hi ", ["title", "body"], filterable)).toEqual(
      or(clause("title", "contains", "hi"), clause("body", "contains", "hi")),
    );
  });

  it("a searchable column must be a declared text column", () => {
    expect(() => lowerSearch("hi", ["n"], filterable)).toThrow(/"n"/);
    expect(() => lowerSearch("hi", ["nope"], filterable)).toThrow(/"nope"/);
  });
});

describe("lowerViewFilter", () => {
  const base = {
    fields: fields.filter((f) => f.id !== "note"),
    resolveOperatorSet: resolve,
    filterable: { title: liveText(), score: liveNumber() },
    now: 0,
  };

  it("lowers the view's rules over field ids, canonically", () => {
    const r = lowerViewFilter({
      ...base,
      group: group(rule("score", "gt", 3), rule("title", "contains", "hi")),
    });
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.filter).toEqual({
      and: [
        { column: "score", op: "gt", operand: 3 },
        { column: "title", op: "contains", operand: "hi" },
      ],
    });
  });

  it("no rule is the absent filter", () => {
    const r = lowerViewFilter({ ...base, group: null });
    expect(r).toEqual({ kind: "ok", filter: undefined, readsClock: false });
  });

  it("a saved rule on a field the source cannot filter is an error, never dropped", () => {
    // Dropping it would run the rest of the filter and show rows the view
    // says it hides.
    const r = lowerViewFilter({
      ...base,
      group: group(rule("score", "gt", 3), rule("note", "contains", "x")),
    });
    expect(r.kind).toBe("error");
    expect(r.kind === "error" && r.error).toBeInstanceOf(
      UnavailableFilterRuleError,
    );
    expect(r.kind === "error" && r.error.message).toContain('"note"');
  });

  it("an unknown operator on a declared field is an error too", () => {
    const r = lowerViewFilter({
      ...base,
      group: group(rule("score", "no-such-op", 3)),
    });
    expect(r.kind === "error" && r.error).toBeInstanceOf(
      UnavailableFilterRuleError,
    );
  });

  it("an INCOMPLETE rule is not an error — it constrains nothing, as authored", () => {
    const r = lowerViewFilter({
      ...base,
      group: group(rule("title", "contains", "")),
    });
    expect(r).toEqual({ kind: "ok", filter: undefined, readsClock: false });
  });

  it("a tree over the language's bounds is an error, never sent or trimmed", () => {
    const rules = Array.from({ length: 51 }, (_, i) => rule("score", "gt", i));
    const r = lowerViewFilter({ ...base, group: group(...rules) });
    expect(r.kind).toBe("error");
    expect(r.kind === "error" && r.error).toBeInstanceOf(FilterError);
    expect(r.kind === "error" && r.error.message).toContain("51 clauses");
  });
});
