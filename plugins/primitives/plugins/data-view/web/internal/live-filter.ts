import { useMemo } from "react";
import {
  canonicalizeFilter,
  clause,
  FilterError,
  or,
  type Filter,
  type Filterable,
} from "@plugins/network/plugins/live/plugins/filter/core";
import type {
  FieldDef,
  FilterGroup,
  FilterNode,
  FilterOperatorSet,
} from "../../core";
import { lowerFilterGroup } from "./evaluate-filter";
import { resolveRuleOperator } from "./rule-resolution";
import { useFilterClock } from "./use-filter-clock";

type ResolveOperatorSet = (typeId: string) => FilterOperatorSet | undefined;

/**
 * A saved rule a live source cannot run: its field's column is not one the
 * collection declares filterable (or the field no longer exists), or its
 * operator is gone.
 * Running the rest of the filter without it would silently show rows the view
 * says it hides, so the query is refused instead.
 */
export class UnavailableFilterRuleError extends Error {
  override name = "UnavailableFilterRuleError";
  constructor(
    readonly rules: readonly { fieldId: string; operatorId: string }[],
  ) {
    super(
      `This view filters on ${rules
        .map((r) => `"${r.fieldId}" (${r.operatorId})`)
        .join(", ")}, which this list cannot filter on — remove ${
        rules.length === 1 ? "that rule" : "those rules"
      } from the filter.`,
    );
  }
}

/**
 * A saved sort rule a live source cannot run: its field's column is not one
 * the collection declares sortable (or the field no longer exists). Sorting
 * without it would silently show another order than the view says, so the
 * query is refused instead.
 */
export class UnavailableSortRuleError extends Error {
  override name = "UnavailableSortRuleError";
  constructor(readonly fieldIds: readonly string[]) {
    super(
      `This view sorts by ${fieldIds
        .map((f) => `"${f}"`)
        .join(", ")}, which this list cannot sort by — remove ${
        fieldIds.length === 1 ? "that rule" : "those rules"
      } from the sort.`,
    );
  }
}

/** The view's filter, lowered: the canonical tree, or why none can be sent. */
export type ViewFilterResult =
  | { kind: "ok"; filter: Filter | undefined }
  | { kind: "error"; error: FilterError | UnavailableFilterRuleError };

/** Every rule in `group` that does not resolve against `fields` (dangling field or operator). */
export function unavailableRules<TRow>(
  group: FilterGroup | null,
  fields: FieldDef<TRow>[],
  resolveOperatorSet: ResolveOperatorSet,
): { fieldId: string; operatorId: string }[] {
  const out: { fieldId: string; operatorId: string }[] = [];
  const walk = (node: FilterNode): void => {
    if (node.kind === "group") node.children.forEach(walk);
    else if (resolveRuleOperator(node, fields, resolveOperatorSet) === null) {
      out.push({ fieldId: node.fieldId, operatorId: node.operatorId });
    }
  };
  if (group) walk(group);
  return out;
}

/**
 * The search box as a filter: `or(contains(col, q) …)` over `searchable` (the
 * trimmed query, matched case-insensitively and literally). Blank → no filter;
 * no searchable column under a non-blank query matches nothing (`or()`).
 */
export function lowerSearch(
  query: string,
  searchable: readonly string[],
  filterable: Filterable,
): Filter | undefined {
  const needle = query.trim();
  if (needle === "") return undefined;
  for (const column of searchable) {
    const domain = Object.hasOwn(filterable, column)
      ? filterable[column]!.domain
      : undefined;
    if (domain !== "text") {
      throw new Error(
        `data-view: searchable column "${column}" must be a declared text column ` +
          `(it is ${domain ?? "undeclared"}).`,
      );
    }
  }
  return or(...searchable.map((column) => clause(column, "contains", needle)));
}

/**
 * The view's `FilterGroup` lowered at `now` over FIELD ids and canonicalized
 * against `filterable` (the source's columns, keyed by the fields that read
 * them — the caller renames onto columns and ANDs in its scope and search).
 * Two things are the `error` arm, never sent and never silently trimmed: a
 * rule the source cannot run (`UnavailableFilterRuleError` — a dangling rule
 * would otherwise constrain nothing and show everything), and a tree the
 * language refuses (over its depth / clause / list bounds).
 */
export function lowerViewFilter<TRow>(args: {
  group: FilterGroup | null;
  fields: FieldDef<TRow>[];
  resolveOperatorSet: ResolveOperatorSet;
  filterable: Filterable;
  now: number;
}): ViewFilterResult & { readsClock: boolean } {
  const unavailable = unavailableRules(
    args.group,
    args.fields,
    args.resolveOperatorSet,
  );
  if (unavailable.length > 0) {
    return {
      kind: "error",
      error: new UnavailableFilterRuleError(unavailable),
      readsClock: false,
    };
  }
  const lowered = lowerFilterGroup(
    args.group,
    args.fields,
    args.resolveOperatorSet,
    args.now,
  );
  try {
    return {
      kind: "ok",
      filter: canonicalizeFilter(lowered.filter, args.filterable),
      readsClock: lowered.readsClock,
    };
  } catch (err) {
    if (!(err instanceof FilterError)) throw err;
    return { kind: "error", error: err, readsClock: lowered.readsClock };
  }
}

/**
 * {@link lowerViewFilter} against the day clock, armed only while a rule
 * reads it (a relative date anchor), so "Today" moves to the new day at local
 * midnight — re-querying the source — and a filter over absolute values never
 * schedules anything. Same probe-then-clock pattern as `useRowFilter`.
 */
export function useViewFilter<TRow>(args: {
  group: FilterGroup | null;
  fields: FieldDef<TRow>[];
  resolveOperatorSet: ResolveOperatorSet;
  filterable: Filterable;
}): ViewFilterResult {
  const { group, fields, resolveOperatorSet, filterable } = args;
  // Whether the filter reads the clock depends only on the operands, never on
  // the clock's value, so it is asked (at 0) before the clock hook needing it.
  const readsClock = useMemo(
    () => lowerFilterGroup(group, fields, resolveOperatorSet, 0).readsClock,
    [group, fields, resolveOperatorSet],
  );
  const now = useFilterClock(readsClock);
  return useMemo(() => {
    const r = lowerViewFilter({
      group,
      fields,
      resolveOperatorSet,
      filterable,
      now,
    });
    return r.kind === "ok"
      ? { kind: "ok", filter: r.filter }
      : { kind: "error", error: r.error };
  }, [group, fields, resolveOperatorSet, filterable, now]);
}
