import { useMemo } from "react";
import type { FieldDef, FilterGroup, FilterOperatorSet } from "../../core";
import {
  lowerFilterGroup,
  makeRowMatcher,
  type UnavailableRule,
} from "./evaluate-filter";
import { useFilterClock } from "./use-filter-clock";

/**
 * A DataView filter tree as an in-memory row filter:
 *
 * - `all` — the tree constrains nothing (no filter, or only incomplete rules),
 *   so a caller can skip the pass entirely;
 * - `match` — the row predicate;
 * - `unavailable` — a rule names a field or operator that does not resolve.
 *   Running the rest of the tree would keep rows the view says it hides, so
 *   there is no predicate to run: the DataView body refuses (it renders the
 *   rule error, or loading while the deferred tier may still contribute it).
 */
export type RowFilter<TRow> =
  | { kind: "all" }
  | { kind: "match"; matches: (row: TRow) => boolean }
  | { kind: "unavailable"; rules: UnavailableRule[] };

/**
 * The predicate of a row filter rendered INSIDE the DataView body, or `null`
 * when it constrains nothing. An `unavailable` filter is `null` here only
 * because the body never renders its view while any rule is unavailable
 * (`resolveBodyState`'s `rule-error` / loading) — a caller outside the body
 * must handle `unavailable` itself.
 */
export function bodyRowMatcher<TRow>(
  filter: RowFilter<TRow>,
): ((row: TRow) => boolean) | null {
  return filter.kind === "match" ? filter.matches : null;
}

/**
 * A DataView filter tree as a {@link RowFilter}: lowered once into the filter
 * language (`lowerFilterGroup`) and matched per row (`makeRowMatcher`).
 *
 * Lowered against `useFilterClock`, armed only while a rule reads the clock, so
 * "Today" moves to the new day at local midnight without re-rendering filters
 * that never mention the time.
 */
export function useRowFilter<TRow>(
  group: FilterGroup | null,
  fields: FieldDef<TRow>[],
  resolveOperatorSet: (typeId: string) => FilterOperatorSet | undefined,
): RowFilter<TRow> {
  // Whether the filter reads the clock does not depend on the clock's VALUE
  // (only on the operands), so it is asked before the clock hook that needs it;
  // the lowering is O(rules), never O(rows).
  const readsClock = useMemo(
    () => lowerFilterGroup(group, fields, resolveOperatorSet, 0).readsClock,
    [group, fields, resolveOperatorSet],
  );
  const now = useFilterClock(readsClock);
  return useMemo((): RowFilter<TRow> => {
    const { filter, unavailable } = lowerFilterGroup(
      group,
      fields,
      resolveOperatorSet,
      now,
    );
    if (unavailable.length > 0)
      return { kind: "unavailable", rules: unavailable };
    return filter === undefined
      ? { kind: "all" }
      : {
          kind: "match",
          matches: makeRowMatcher(filter, fields, resolveOperatorSet),
        };
  }, [group, fields, resolveOperatorSet, now]);
}
