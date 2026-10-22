import { useMemo } from "react";
import {
  and,
  canonicalizeFilter,
  filterColumns,
  FilterError,
  type Filter,
  type Filterable,
} from "@plugins/network/plugins/live/plugins/filter/core";
import type {
  LiveCollection,
  LiveColumnsDeclaration,
} from "@plugins/network/plugins/live/core";
import type {
  DataViewRowsCollection,
  LiveDataSource,
  ViewState,
} from "../../core";
import { useResolveOperatorSet } from "../filter-slot";
import { useDerivedFields } from "./derived-fields";
import {
  namedColumnSets,
  renameColumns,
  resolveLiveFields,
} from "./live-fields";
import { useWidenedViewFilter } from "./live-filter";

/**
 * A paged read narrowed by a view's filter: the `where` to AND into its query
 * (over the collection's columns), the column sets it names, whether it is
 * the view's WHOLE filter (no rule dropped) — so a count over it is the
 * view's — and whether a COUNT can read it at all (it names no contributed
 * column: a count, like a `GROUP BY`, reads the own and exposed columns only).
 * `none`: the view filters by nothing the collection's columns can run.
 */
export type PagesNarrowing =
  | { kind: "none" }
  | {
      kind: "narrowed";
      where: Filter;
      columns: readonly LiveColumnsDeclaration[];
      whole: boolean;
      countable: boolean;
    };

const NONE: PagesNarrowing = { kind: "none" };

/**
 * Lower `view`'s filter onto `collection`'s columns, for an in-memory DataView
 * whose rows include a paged read of it (`useLivePagesPaging`'s `narrowBy`):
 * the fields the collection derives — the same ids the DataView's own derived
 * from it — are resolved against its columns exactly as a live source's are,
 * and the filter lowered as a WIDENING (`useWidenedViewFilter`): a rule over a
 * field no column backs (a list's own synthetic field) is dropped, never
 * refused, because the DataView still filters the rows in memory. So the read
 * pages through the rows the view can show, and its tail — the row the next
 * page waits on — is one the view shows.
 *
 * The search box is not lowered: in memory it matches any searchable field's
 * text, which no column `contains` restates.
 */
export function usePagesNarrowing<Row, F, S extends string>(
  collection: LiveCollection<Row, F, S> | null,
  view: ViewState | undefined,
): PagesNarrowing {
  const narrowed = view !== undefined ? collection : null;
  const derived = useDerivedFields(
    narrowed === null
      ? undefined
      : (narrowed as unknown as DataViewRowsCollection),
    true,
  );
  const resolveOperatorSet = useResolveOperatorSet();
  const source = useMemo(
    (): LiveDataSource<unknown> | null =>
      narrowed === null
        ? null
        : {
            kind: "live",
            collection: narrowed as unknown as LiveCollection<
              unknown,
              unknown,
              string
            >,
            searchable: [],
            facets: [],
            scope: { kind: "all" },
          },
    [narrowed],
  );
  const plan = useMemo(
    () =>
      source === null
        ? null
        : resolveLiveFields(
            derived.fields,
            source,
            resolveOperatorSet,
            "useLivePagesPaging narrowBy",
          ),
    [source, derived.fields, resolveOperatorSet],
  );
  const widened = useWidenedViewFilter({
    group: plan ? (view?.filter ?? null) : null,
    fields: plan?.filterFields ?? NO_FIELDS,
    resolveOperatorSet,
    filterable: plan?.filterable ?? NO_FILTERABLE,
  });
  return useMemo((): PagesNarrowing => {
    if (source === null || plan === null || widened.filter === undefined)
      return NONE;
    const declared: Filterable = {
      ...(source.collection.filterable as unknown as Filterable),
      ...Object.assign(
        {},
        ...[...plan.handles.values()].map((h) => h.wireFilterable),
      ),
    };
    let where: Filter | undefined;
    try {
      where = canonicalizeFilter(
        renameColumns(widened.filter, (fieldId) => plan.columnOf.get(fieldId)!),
        declared,
      );
    } catch (err) {
      // Over the language's bounds once renamed: read unnarrowed — the view
      // still filters in memory, so this widens, never hides.
      if (!(err instanceof FilterError)) throw err;
      return NONE;
    }
    if (where === undefined) return NONE;
    const { sets, contributed } = namedColumnSets(
      plan.handles,
      filterColumns(where),
    );
    return {
      kind: "narrowed",
      where,
      columns: sets,
      whole: widened.whole,
      countable: contributed.length === 0,
    };
  }, [source, plan, widened]);
}

/** A query's own `where` with the narrowing ANDed in after it. */
export function narrowWhere(
  base: Filter | undefined,
  narrowing: Extract<PagesNarrowing, { kind: "narrowed" }>,
): Filter {
  return base === undefined ? narrowing.where : and(base, narrowing.where);
}

const NO_FIELDS: never[] = [];
const NO_FILTERABLE: Filterable = {};
