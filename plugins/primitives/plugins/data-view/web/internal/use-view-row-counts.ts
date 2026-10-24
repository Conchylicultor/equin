import { useCallback, useMemo } from "react";
import { useViewGetter } from "@plugins/primitives/plugins/data-view/plugins/view-core/web";
import type { FieldDef, FilterGroup, FilterOperatorSet } from "../../core";
import { useDataViewControls } from "../components/controls/controls-context";
import { lowerFilterGroup, makeRowMatcher } from "./evaluate-filter";
import { useFilterClock } from "./use-filter-clock";

type ResolveOperatorSet = (typeId: string) => FilterOperatorSet | undefined;

/**
 * How many of the surface's rows each view's FILTER keeps — what a list of the
 * views (`DataViewViewList`, the drafts chip) draws beside each name. Reads the
 * controls context, so it is called from the band, the `aside` or the
 * `asideEnd`.
 *
 * The search query is not applied: a count says what the view holds, not what
 * one search over it shows. `undefined` while it cannot be known — rows not in
 * memory (a live source's are the server's; `rows` is `null` there and while
 * they load) or a rule naming a field or operator that does not resolve — so
 * the caller draws nothing rather than a wrong number.
 *
 * Each view's count is computed once per (filter, rows, schema, clock) and
 * kept until one of them changes (a `ViewGetter`), so an edit to one view's
 * filter recounts that view alone.
 */
export function useViewRowCounts(): (viewId: string) => number | undefined {
  const { rows, fields, viewModel, filter } = useDataViewControls();
  const { resolveOperatorSet } = filter;
  const { instances, stateFor } = viewModel;
  // One clock for every view, armed only while some view's filter reads it.
  const readsClock = useMemo(
    () =>
      rows !== null &&
      instances.some(
        (r) =>
          lowerFilterGroup(
            stateFor(r.instance.id).filter,
            fields,
            resolveOperatorSet,
            0,
          ).readsClock,
      ),
    [rows, instances, stateFor, fields, resolveOperatorSet],
  );
  const now = useFilterClock(readsClock);
  return useViewGetter(
    useCallback(
      (id: string) =>
        [stateFor(id).filter, rows, fields, resolveOperatorSet, now] as const,
      [stateFor, rows, fields, resolveOperatorSet, now],
    ),
    countRows,
  );
}

/** The rows `filter` keeps, or `undefined` when that cannot be said. */
function countRows(
  filter: FilterGroup | null,
  rows: readonly unknown[] | null,
  fields: FieldDef<unknown>[],
  resolveOperatorSet: ResolveOperatorSet,
  now: number,
): number | undefined {
  if (rows === null) return undefined;
  const lowered = lowerFilterGroup(filter, fields, resolveOperatorSet, now);
  if (lowered.unavailable.length > 0) return undefined;
  if (lowered.filter === undefined) return rows.length;
  const matches = makeRowMatcher(lowered.filter, fields, resolveOperatorSet);
  let count = 0;
  for (const row of rows) if (matches(row)) count++;
  return count;
}
