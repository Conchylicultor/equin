import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Filter } from "@plugins/network/plugins/live/plugins/filter/core";
import type {
  LiveCollection,
  LiveGroup,
  LiveWhere,
} from "@plugins/network/plugins/live/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  ResourceError,
  refuseResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type {
  FieldDef,
  FieldOption,
  FieldOptionsResult,
  LiveDataSource,
} from "../../core";
import { resolveLiveFields, type ResolveOperatorSet } from "./live-fields";

// A live source's FACETS (`liveDataSource({ facets })`): each facet column's
// values, read live as a grouping over the source's scope, handed to the field
// over that column as its `optionsResult` — what the Filter control offers.
//
// The reads run in sibling components (one per facet, keyed by what it reads)
// that report their result up, rather than as hooks in the body: the facet set
// is the source's, and the scope can change from `awaiting` (read nothing) to
// `where` under a mounted body — a nested chain would remount the body there.

/** The grouping a facet reads, typed loosely: the facet column is checked at `liveDataSource`. */
type FacetCollection = LiveCollection<
  Record<string, unknown>,
  Record<string, { domain: "text" }>,
  string
>;

const LOADING: FieldOptionsResult = { status: "loading" };

/**
 * A facet grouping read as an option state. Options are the non-NULL values,
 * sorted by value (locale compare) — never the grouping's count order, so a
 * count change never moves an option under the cursor, and a new value is
 * inserted in place.
 *
 * Complete or loud: a grouping that came back FULL at `maxLimit` may have more
 * values than it returned, so it is refused (the error arm) — a facet missing
 * values would offer a filter that cannot pick them.
 */
export function facetOptionsResult(
  read: ResourceResult<readonly LiveGroup<unknown>[]>,
  column: string,
  maxLimit: number,
): FieldOptionsResult {
  const checked = refuseResource(read, (groups) =>
    groups.length >= maxLimit
      ? new ResourceError(
          "loader-failed",
          `"${column}" takes more than ${maxLimit - 1} values — more than one facet read lists, so its options would be incomplete.`,
          null,
        )
      : null,
  );
  switch (checked.status) {
    case "loading":
      return LOADING;
    case "error":
      return checked;
    case "ready": {
      const options: FieldOption[] = checked.data
        .flatMap((g) => (g.value === null ? [] : [String(g.value)]))
        .sort((a, b) => a.localeCompare(b))
        .map((value) => ({ value, label: value }));
      return { status: "ready", options };
    }
  }
}

/**
 * The facet column each field reads, checked: every facet is read by a field
 * (a facet no field shows is a read nothing renders), and a field over a facet
 * declares no `options` of its own (its options ARE the facet's).
 */
export function facetFieldColumns(
  fields: readonly FieldDef<unknown>[],
  facets: readonly string[],
  columnOf: ReadonlyMap<string, string>,
  collectionKey: string,
): ReadonlyMap<string, string> {
  const facetSet = new Set(facets);
  const byField = new Map<string, string>();
  for (const field of fields) {
    const column = columnOf.get(field.id);
    if (column === undefined || !facetSet.has(column)) continue;
    if (field.options !== undefined) {
      throw new Error(
        `data-view: field "${field.id}" declares \`options\`, but its column "${column}" is a facet of "${collectionKey}" — a facet's options are read, not declared.`,
      );
    }
    byField.set(field.id, column);
  }
  const read = new Set(byField.values());
  const unread = facets.find((f) => !read.has(f));
  if (unread !== undefined) {
    throw new Error(
      `data-view: "${collectionKey}" declares the facet "${unread}", but no field reads that column — its options would be read for nothing.`,
    );
  }
  return byField;
}

/** Hand each facet field its read state (loading until its reader reported). */
export function withFacetOptions(
  fields: FieldDef<unknown>[],
  facetColumnOf: ReadonlyMap<string, string>,
  resultOf: (column: string) => FieldOptionsResult | undefined,
): FieldDef<unknown>[] {
  if (facetColumnOf.size === 0) return fields;
  return fields.map((field) => {
    const column = facetColumnOf.get(field.id);
    if (column === undefined) return field;
    // `facetFieldColumns` checked it declares no `options`.
    const { options: _declared, ...rest } = field;
    return { ...rest, optionsResult: resultOf(column) ?? LOADING };
  });
}

/** One facet's read, reported up (renders nothing). */
function FacetRead(props: {
  collection: FacetCollection;
  column: string;
  where: Filter | undefined;
  readKey: string;
  onResult: (readKey: string, result: FieldOptionsResult) => void;
}): ReactNode {
  const { collection, column, where, readKey, onResult } = props;
  const maxLimit = collection.groups.groups.maxLimit;
  const read = useLive(collection, {
    groupBy: column,
    ...(where === undefined
      ? {}
      : { where: where as LiveWhere<Record<string, { domain: "text" }>> }),
    limit: maxLimit,
  });
  const result = useMemo(
    () => facetOptionsResult(read, column, maxLimit),
    [read, column, maxLimit],
  );
  useEffect(() => onResult(readKey, result), [onResult, readKey, result]);
  return null;
}

/**
 * Overlay a live source's facet reads onto the schema: each field over a facet
 * column gets `optionsResult` — `loading` until its read reports (and while the
 * scope is awaited: no read runs then), then the read's state. A source with
 * no facets (or no source) passes `fields` through untouched.
 */
export function CollectFacetOptions(props: {
  source: LiveDataSource<unknown> | undefined;
  fields: FieldDef<unknown>[];
  resolveOperatorSet: ResolveOperatorSet;
  children: (fields: FieldDef<unknown>[]) => ReactNode;
}): ReactNode {
  const { source, fields, resolveOperatorSet, children } = props;
  const facets = source?.facets ?? NO_FACETS;
  const scope = source?.scope;
  const where = scope?.kind === "where" ? scope.filter : undefined;
  // What a read is OF: its column plus the scope it groups over. A result
  // reported under another key (the scope moved since) is not this read's.
  const scopeKey = JSON.stringify(where ?? null);
  const readKeyOf = useCallback(
    (column: string) => `${column}\u0000${scopeKey}`,
    [scopeKey],
  );

  const facetColumnOf = useMemo(
    () =>
      source === undefined || facets.length === 0
        ? NO_COLUMNS
        : facetFieldColumns(
            fields,
            facets,
            resolveLiveFields(fields, source, resolveOperatorSet, "fields")
              .columnOf,
            source.collection.key,
          ),
    [source, fields, facets, resolveOperatorSet],
  );

  const [results, setResults] = useState<
    ReadonlyMap<string, FieldOptionsResult>
  >(() => new Map());
  const onResult = useCallback(
    (readKey: string, result: FieldOptionsResult) =>
      setResults((prev) => {
        // The option list's identity follows its VALUES, not the read: a
        // count change re-reads the grouping but keeps the field as it was.
        if (sameOptions(prev.get(readKey), result)) return prev;
        const next = new Map(prev);
        next.set(readKey, result);
        return next;
      }),
    [],
  );

  const faceted = useMemo(
    () =>
      withFacetOptions(fields, facetColumnOf, (column) =>
        results.get(readKeyOf(column)),
      ),
    [fields, facetColumnOf, results, readKeyOf],
  );

  // An awaited scope reads nothing: its facets stay `loading`.
  const reads =
    source === undefined || scope?.kind === "awaiting"
      ? null
      : facets.map((column) => (
          <FacetRead
            key={readKeyOf(column)}
            collection={source.collection as unknown as FacetCollection}
            column={column}
            where={where}
            readKey={readKeyOf(column)}
            onResult={onResult}
          />
        ));
  return (
    <>
      {children(faceted)}
      {reads}
    </>
  );
}

/** Whether two states are the same one: identical, or ready with the same option values. */
function sameOptions(
  a: FieldOptionsResult | undefined,
  b: FieldOptionsResult,
): boolean {
  if (a === b) return true;
  if (a?.status !== "ready" || b.status !== "ready") return false;
  return (
    a.options.length === b.options.length &&
    a.options.every((o, i) => o.value === b.options[i]!.value)
  );
}

const NO_FACETS: readonly string[] = [];
const NO_COLUMNS: ReadonlyMap<string, string> = new Map();
