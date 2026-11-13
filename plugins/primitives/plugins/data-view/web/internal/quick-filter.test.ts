import { describe, expect, it } from "bun:test";
import type { FilterGroup, FilterNode, QuickFilter } from "../../core";
import { activeQuickOption, applyQuickOption } from "./quick-filter";

const OWNER: QuickFilter = {
  id: "owner",
  fieldId: "owner",
  label: "Whose visits",
  options: [
    {
      id: "visitors",
      label: "Visitors",
      rule: { operatorId: "is", value: false },
    },
    { id: "you", label: "You", rule: { operatorId: "is", value: true } },
    { id: "all", label: "All", rule: null },
  ],
};

const RANGE: QuickFilter = {
  id: "range",
  fieldId: "startedAt",
  label: "Since",
  options: [
    {
      id: "7d",
      label: "7d",
      rule: { operatorId: "is-within-past", value: { amount: 7, unit: "day" } },
    },
    {
      id: "30d",
      label: "30d",
      rule: {
        operatorId: "is-within-past",
        value: { amount: 30, unit: "day" },
      },
    },
  ],
};

function and(...children: FilterNode[]): FilterGroup {
  return { kind: "group", id: "root", conjunction: "and", children };
}

const visitors: FilterNode = {
  kind: "rule",
  id: "r-visitors",
  fieldId: "owner",
  operatorId: "is",
  value: false,
};
const range: FilterNode = {
  kind: "rule",
  id: "r-range",
  fieldId: "startedAt",
  operatorId: "is-within-past",
  // Key order differs from the option's: matched by canonical value.
  value: { unit: "day", amount: 7 },
};
const saved = and(visitors, range);

describe("activeQuickOption", () => {
  it("reads the option the field's one top-level rule is", () => {
    expect(activeQuickOption(saved, OWNER)).toBe("visitors");
    expect(activeQuickOption(saved, RANGE)).toBe("7d");
  });

  it("no rule on the field is the null option (or none when there is none)", () => {
    expect(activeQuickOption(null, OWNER)).toBe("all");
    expect(activeQuickOption(and(range), OWNER)).toBe("all");
    expect(activeQuickOption(and(visitors), RANGE)).toBeNull();
  });

  it("a rule no option names reads as custom", () => {
    const edited = and({ ...visitors, operatorId: "is-not" }, range);
    expect(activeQuickOption(edited, OWNER)).toBeNull();
    const two = and(visitors, { ...visitors, id: "x", value: true });
    expect(activeQuickOption(two, OWNER)).toBeNull();
  });

  it("a nested or or-root rule on the field reads as custom", () => {
    expect(activeQuickOption(and(range, and(visitors)), OWNER)).toBeNull();
    expect(
      activeQuickOption({ ...saved, conjunction: "or" }, OWNER),
    ).toBeNull();
    // An `or` root with nothing on the field: the null option still holds.
    expect(activeQuickOption({ ...and(range), conjunction: "or" }, OWNER)).toBe(
      "all",
    );
  });
});

describe("applyQuickOption", () => {
  it("replaces the field's rule in place, keeping its id", () => {
    const next = applyQuickOption(saved, OWNER, OWNER.options[1]!);
    expect(next).toEqual(and({ ...visitors, value: true }, range));
    expect(activeQuickOption(next, OWNER)).toBe("you");
  });

  it("picking the saved option back gives the saved tree", () => {
    const you = applyQuickOption(saved, OWNER, OWNER.options[1]!);
    expect(applyQuickOption(you, OWNER, OWNER.options[0]!)).toEqual(saved);
  });

  it("the null option drops the field's rules; an empty tree is null", () => {
    expect(applyQuickOption(saved, OWNER, OWNER.options[2]!)).toEqual(
      and(range),
    );
    expect(
      applyQuickOption(and(visitors), OWNER, OWNER.options[2]!),
    ).toBeNull();
    expect(applyQuickOption(null, OWNER, OWNER.options[2]!)).toBeNull();
  });

  it("appends to a tree without the field, and builds one from none", () => {
    const next = applyQuickOption(and(visitors), RANGE, RANGE.options[1]!);
    expect(next?.children).toHaveLength(2);
    expect(activeQuickOption(next, RANGE)).toBe("30d");
    const fresh = applyQuickOption(null, OWNER, OWNER.options[0]!);
    expect(fresh?.conjunction).toBe("and");
    expect(activeQuickOption(fresh, OWNER)).toBe("visitors");
  });

  it("drops every top-level rule on the field", () => {
    const two = and(visitors, range, { ...visitors, id: "x", value: true });
    const next = applyQuickOption(two, OWNER, OWNER.options[1]!);
    expect(next).toEqual(and({ ...visitors, value: true }, range));
  });

  it("wraps an or root in an and group", () => {
    const or: FilterGroup = { ...and(range), conjunction: "or" };
    const next = applyQuickOption(or, OWNER, OWNER.options[0]!);
    expect(next?.conjunction).toBe("and");
    expect(next?.children[0]).toEqual(or);
    expect(activeQuickOption(next, OWNER)).toBe("visitors");
  });
});
