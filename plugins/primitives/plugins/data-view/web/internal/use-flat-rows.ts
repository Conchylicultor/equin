import { useMemo } from "react";
import type { FieldDef, FilterOperatorSet, ViewState } from "../../core";
import { bodyRowMatcher, useRowFilter } from "./use-row-filter";
import { makeSortComparator } from "./sort-rows";

function isSearchable<TRow>(field: FieldDef<TRow>): boolean {
  if (field.filterable === true) return true;
  if (field.filterable === false) return false;
  const type = field.type ?? "text";
  return type === "text" || type === "enum" || type === "tags";
}

/**
 * The view's search and filter as ONE row predicate — the rows `useFlatRows`
 * keeps — or `null` when neither constrains.
 */
export function useRowMatcher<TRow>(
  fields: FieldDef<TRow>[],
  state: Pick<ViewState, "query" | "filter">,
  resolveOperatorSet: (typeId: string) => FilterOperatorSet | undefined,
  searchAccessor?: (row: TRow) => string,
): ((row: TRow) => boolean) | null {
  // The filter tree lowered into the filter language once per (tree, clock),
  // never per row; null ⇒ nothing constrains (an unavailable rule never
  // reaches here: the body refuses to render the view — `bodyRowMatcher`).
  const matchesFilter = bodyRowMatcher(
    useRowFilter(state.filter, fields, resolveOperatorSet),
  );
  const query = state.query.trim();
  return useMemo(() => {
    // --- Search (substring, case-insensitive) ---
    const accessor =
      searchAccessor ??
      ((row: TRow) =>
        fields
          .filter((f) => isSearchable(f))
          .map((f) =>
            f.values ? f.values(row).join(" ") : String(f.value?.(row) ?? ""),
          )
          .join(" "));
    const lc = query.toLowerCase();
    const matchesSearch = query
      ? (row: TRow) => accessor(row).toLowerCase().includes(lc)
      : null;
    // --- Filter (the tree lowered through the data-view.filter operator sets) ---
    if (matchesSearch && matchesFilter)
      return (row) => matchesSearch(row) && matchesFilter(row);
    return matchesSearch ?? matchesFilter;
  }, [query, fields, matchesFilter, searchAccessor]);
}

/**
 * The view's rows, searched, filtered and sorted in memory. For a view rendered
 * by the DataView body: a filter rule that does not resolve is not applied
 * here (`bodyRowMatcher`), because the body shows the rule error in place of
 * the view. A caller outside the body that needs to know reads `useRowFilter`.
 */
export function useFlatRows<TRow>(
  rows: readonly TRow[],
  fields: FieldDef<TRow>[],
  state: ViewState,
  resolveOperatorSet: (typeId: string) => FilterOperatorSet | undefined,
  searchAccessor?: (row: TRow) => string,
): readonly TRow[] {
  const matches = useRowMatcher(
    fields,
    state,
    resolveOperatorSet,
    searchAccessor,
  );
  return useMemo(() => {
    const result = matches ? rows.filter(matches) : [...rows];

    // --- Sort (multi-level, stable; null when no rule resolves) ---
    const comparator = makeSortComparator(state.sort, fields);
    if (comparator) result.sort(comparator);

    return result;
  }, [rows, fields, state.sort, matches]);
}
