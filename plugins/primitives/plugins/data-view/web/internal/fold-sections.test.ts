import { describe, expect, test } from "bun:test";
import { clause } from "@plugins/network/plugins/live/plugins/filter/core";
import {
  UNGROUPED_FOLD_KEY,
  type DataViewRowEntry,
  type DataViewSection,
  type FieldDef,
  type FilterOperatorSet,
  type FoldRule,
  type ViewState,
} from "../../core";
import {
  describeFold,
  effectiveFold,
  foldRuleOf,
  foldSections,
  isTailFolded,
  makeFoldKeep,
} from "./fold-sections";
import { aggregateSections } from "./use-data-view-sections";
import { lowerFilterGroup, makeRowMatcher } from "./evaluate-filter";

interface Conv {
  id: string;
  age: number;
}

const ageField: FieldDef<Conv> = {
  id: "age",
  label: "Age",
  type: "number",
  value: (c) => c.age,
};

/** A one-operator stand-in for the number type's operator set, so this suite
 *  proves the mechanism without importing any field type. */
const numberOps: FilterOperatorSet = {
  match: "number",
  domain: "number",
  operators: [
    {
      id: "lt",
      label: "Is less than",
      hasValue: true,
      lower: (operand, { column }) =>
        typeof operand === "number" ? clause(column, "lt", operand) : undefined,
    },
  ],
};
const resolveOps = (typeId: string) =>
  typeId === "number" ? numberOps : undefined;

/** Keep rows younger than 30 (days). */
const RECENT: FoldRule = {
  keep: {
    kind: "group",
    id: "keep",
    conjunction: "and",
    children: [
      { kind: "rule", id: "r", fieldId: "age", operatorId: "lt", value: 30 },
    ],
  },
};

const rowKey = (c: Conv) => c.id;
const entry = (c: Conv): DataViewRowEntry<Conv> => ({ row: c, key: c.id });

function section(key: string | null, rows: Conv[]): DataViewSection<Conv> {
  return {
    key,
    label: key ?? undefined,
    count: { kind: "exact", n: rows.length },
    entries: rows.map(entry),
  };
}

function keepFor(selectedRowId?: string, limit?: number) {
  const { filter } = lowerFilterGroup(RECENT.keep!, [ageField], resolveOps, 0);
  const matchesKeep = filter
    ? makeRowMatcher(filter, [ageField], resolveOps)
    : null;
  return makeFoldKeep(matchesKeep, {
    limit,
    selectedRowId,
    rowKey,
  });
}

/** A limit-only fold: no keep rule, the first `limit` entries. */
function firstN(limit: number, selectedRowId?: string) {
  return makeFoldKeep<Conv>(null, { limit, selectedRowId, rowKey });
}

const a = { id: "a", age: 1 };
const b = { id: "b", age: 90 };
const c = { id: "c", age: 5 };
const d = { id: "d", age: 60 };

describe("foldSections", () => {
  test("splits kept from hidden rows and leaves the total count untouched", () => {
    const [s] = foldSections([section("done", [a, b, c, d])], {
      keep: keepFor(),
      openKeys: new Set(),
    });
    expect(s!.entries.map((e) => e.key)).toEqual(["a", "c"]);
    expect(s!.fold).toEqual({ hidden: 2, open: false });
    expect(s!.count).toEqual({ kind: "exact", n: 4 });
  });

  test("a section whose rows are all folded keeps its header", () => {
    const sections = foldSections(
      [section("queue", [a]), section("old", [b, d])],
      { keep: keepFor(), openKeys: new Set() },
    );
    expect(sections.map((s) => s.key)).toEqual(["queue", "old"]);
    const old = sections[1]!;
    expect(old.label).toBe("old");
    expect(old.entries).toEqual([]);
    expect(old.count).toEqual({ kind: "exact", n: 2 });
    expect(old.fold).toEqual({ hidden: 2, open: false });
  });

  test("the selected row is never folded", () => {
    const [s] = foldSections([section("done", [a, b, d])], {
      keep: keepFor("b"),
      openKeys: new Set(),
    });
    expect(s!.entries.map((e) => e.key)).toEqual(["a", "b"]);
    expect(s!.fold).toEqual({ hidden: 1, open: false });
  });

  test("an open fold line shows every entry, in sorted order", () => {
    const [s] = foldSections([section("done", [b, a, d, c])], {
      keep: keepFor(),
      openKeys: new Set(["done"]),
    });
    expect(s!.entries.map((e) => e.key)).toEqual(["b", "a", "d", "c"]);
    expect(s!.fold).toEqual({ hidden: 2, open: true });
  });

  test("the implicit ungrouped section opens under UNGROUPED_FOLD_KEY", () => {
    const [s] = foldSections([section(null, [a, b])], {
      keep: keepFor(),
      openKeys: new Set([UNGROUPED_FOLD_KEY]),
    });
    expect(s!.fold).toEqual({ hidden: 1, open: true });
    expect(s!.entries).toHaveLength(2);
  });

  test("a section with no failing row carries no fold", () => {
    const input = section("fresh", [a, c]);
    const [s] = foldSections([input], {
      keep: keepFor(),
      openKeys: new Set(),
    });
    expect(s).toBe(input);
    expect(s!.fold).toBeUndefined();
  });

  test("an aggregate entry is decided by its representative", () => {
    // Members `b` (old) and `c` (recent) collapse into one entry.
    const agg = aggregateSections([section("done", [b, c, d])], {
      getKey: (r) => (r.id === "d" ? null : "pair"),
    });
    const oldRep = foldSections(agg, {
      keep: keepFor(),
      openKeys: new Set(),
    });
    // Representative defaults to the first member, `b` — old, so it folds.
    expect(oldRep[0]!.entries).toEqual([]);
    expect(oldRep[0]!.fold).toEqual({ hidden: 2, open: false });

    const recentRep = aggregateSections([section("done", [b, c, d])], {
      getKey: (r) => (r.id === "d" ? null : "pair"),
      pickRepresentative: (members) => members[1]!,
    });
    const [s] = foldSections(recentRep, {
      keep: keepFor(),
      openKeys: new Set(),
    });
    expect(s!.entries.map((e) => e.row.id)).toEqual(["c"]);
    expect(s!.fold).toEqual({ hidden: 1, open: false });
  });

  test("an aggregate entry holding the selected row is kept", () => {
    const agg = aggregateSections([section("done", [b, d])], {
      getKey: () => "pair",
    });
    const [s] = foldSections(agg, {
      keep: keepFor("d"),
      openKeys: new Set(),
    });
    expect(s!.entries).toHaveLength(1);
    expect(s!.fold).toBeUndefined();
  });
});

describe("effectiveFold", () => {
  const base: ViewState = { sort: [], filter: null, query: "", fold: RECENT };

  test("is the view's fold when nothing is searched", () => {
    expect(effectiveFold(base)).toBe(RECENT);
  });

  test("search suspends folding", () => {
    expect(effectiveFold({ ...base, query: "old" })).toBeUndefined();
  });

  test("a whitespace-only query is not a search", () => {
    expect(effectiveFold({ ...base, query: "  " })).toBe(RECENT);
  });
});

describe("isTailFolded", () => {
  const opts = (openCount: number, fold: FoldRule | null = RECENT) => ({
    fold: fold ?? undefined,
    openCount,
    keep: keepFor(),
  });

  test("true when the last loaded row is folded and no fold is open", () => {
    expect(isTailFolded([a, b].map(entry), opts(0))).toBe(true);
  });

  test("false once any fold line is open", () => {
    expect(isTailFolded([a, b].map(entry), opts(1))).toBe(false);
  });

  test("false when the last loaded row is kept", () => {
    expect(isTailFolded([b, a].map(entry), opts(0))).toBe(false);
  });

  test("false with no fold in effect, or no rows", () => {
    expect(isTailFolded([a, b].map(entry), opts(0, null))).toBe(false);
    expect(isTailFolded([], opts(0))).toBe(false);
  });

  test("a limit folds the tail once the section holds more than it", () => {
    const fold: FoldRule = { limit: 2 };
    const keep = firstN(2);
    expect(isTailFolded([a, b].map(entry), { fold, openCount: 0, keep })).toBe(
      false,
    );
    expect(
      isTailFolded([a, b, c].map(entry), { fold, openCount: 0, keep }),
    ).toBe(true);
  });
});

describe("fold limit", () => {
  test("keeps each section's first N entries in their order", () => {
    const [s] = foldSections([section("done", [b, a, d, c])], {
      keep: firstN(2),
      openKeys: new Set(),
    });
    expect(s!.entries.map((e) => e.key)).toEqual(["b", "a"]);
    expect(s!.fold).toEqual({ hidden: 2, open: false });
    expect(s!.count).toEqual({ kind: "exact", n: 4 });
  });

  test("a section within the limit carries no fold", () => {
    const input = section("done", [a, b]);
    const [s] = foldSections([input], { keep: firstN(2), openKeys: new Set() });
    expect(s).toBe(input);
  });

  test("limits every section on its own", () => {
    const sections = foldSections(
      [section("x", [a, b, c]), section("y", [d, a, b])],
      { keep: firstN(1), openKeys: new Set() },
    );
    expect(sections.map((s) => s.entries.map((e) => e.key))).toEqual([
      ["a"],
      ["d"],
    ]);
    expect(sections.map((s) => s.fold?.hidden)).toEqual([2, 2]);
  });

  test("with a keep rule, counts only the kept entries", () => {
    // Kept by the rule: a, c, e — the limit keeps the first two of those.
    const e = { id: "e", age: 2 };
    const [s] = foldSections([section("done", [b, a, d, c, e])], {
      keep: keepFor(undefined, 2),
      openKeys: new Set(),
    });
    expect(s!.entries.map((x) => x.key)).toEqual(["a", "c"]);
    expect(s!.fold).toEqual({ hidden: 3, open: false });
  });

  test("the selected row past the limit is shown as well, in place", () => {
    const [s] = foldSections([section("done", [a, b, c, d])], {
      keep: firstN(2, "d"),
      openKeys: new Set(),
    });
    expect(s!.entries.map((x) => x.key)).toEqual(["a", "b", "d"]);
    expect(s!.fold).toEqual({ hidden: 1, open: false });
  });

  test("the selected row inside the limit takes a slot", () => {
    const [s] = foldSections([section("done", [a, b, c, d])], {
      keep: firstN(2, "a"),
      openKeys: new Set(),
    });
    expect(s!.entries.map((x) => x.key)).toEqual(["a", "b"]);
  });

  test("an open line shows every entry", () => {
    const [s] = foldSections([section("done", [a, b, c])], {
      keep: firstN(1),
      openKeys: new Set(["done"]),
    });
    expect(s!.entries).toHaveLength(3);
    expect(s!.fold).toEqual({ hidden: 2, open: true });
  });

  test("an aggregate entry counts once", () => {
    const agg = aggregateSections([section("done", [a, b, c, d])], {
      getKey: (r) => (r.id === "a" || r.id === "b" ? "pair" : null),
    });
    const [s] = foldSections(agg, { keep: firstN(2), openKeys: new Set() });
    expect(s!.entries.map((x) => x.row.id)).toEqual(["a", "c"]);
    expect(s!.fold).toEqual({ hidden: 1, open: false });
  });

  test("search suspends a limit like any fold", () => {
    const state: ViewState = {
      sort: [],
      filter: null,
      query: "x",
      fold: { limit: 3 },
    };
    expect(effectiveFold(state)).toBeUndefined();
  });
});

describe("foldRuleOf", () => {
  test("puts a keep and a limit together, dropping an empty keep", () => {
    const empty = { ...RECENT.keep!, children: [] };
    expect(foldRuleOf(RECENT.keep, 5)).toEqual({
      keep: RECENT.keep!,
      limit: 5,
    });
    expect(foldRuleOf(RECENT.keep, undefined)).toEqual({ keep: RECENT.keep! });
    expect(foldRuleOf(empty, 5)).toEqual({ limit: 5 });
    expect(foldRuleOf(null, undefined)).toBeNull();
  });
});

describe("describeFold", () => {
  const keep = { label: "Age is less than 30", more: 0 };
  test("says the limit, the keep rule, or both", () => {
    expect(describeFold({ limit: 10 }, null)).toBe(
      "Folding all but the first 10",
    );
    expect(describeFold(RECENT, keep)).toBe(
      "Folding all but: Age is less than 30",
    );
    expect(describeFold({ keep: RECENT.keep!, limit: 10 }, keep)).toBe(
      "Folding all but the first 10 of: Age is less than 30",
    );
  });
});
