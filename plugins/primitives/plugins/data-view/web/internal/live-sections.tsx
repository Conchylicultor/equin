import { useEffect, useMemo, type ReactNode } from "react";
import {
  and,
  canonicalizeFilter,
  clause,
  filterDomains,
  type Filter,
  type Filterable,
} from "@plugins/network/plugins/live/plugins/filter/core";
import type {
  LiveCollection,
  LiveColumnsDeclaration,
  LiveGroup,
  LiveOrderBy,
  LiveWhere,
} from "@plugins/network/plugins/live/core";
import { useLive } from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import type {
  DataViewPaging,
  FieldDef,
  FieldGrouping,
  FieldValue,
  LiveDataSource,
} from "../../core";
import type { LiveGroupColumn } from "./live-fields";
import { NO_VIEWPORT } from "./pages-viewport";
import { NO_PLACEHOLDERS } from "./pages-paging";
import { useLivePagesPaging } from "./use-live-pages-paging";
import { NULL_GROUP_KEY, nullGroupLabel } from "./use-data-view-sections";

// A live source grouped by a groupable column, server-sectioned
// (research/2026-10-08-primitives-data-view-live-server-sections.md): ONE
// `GROUP BY` read lists every section with its exact count, and each section
// the user has opened and scrolled to reads its own rows. The reads run in
// sibling components that report up (the `FacetRead` pattern), so a section
// opening or closing never remounts the body, and no hook runs in a loop.

/** What a section's server-side group stands for. */
export interface ServerSection {
  key: string;
  label: string;
  /** The ordinal the grouping gave it — the section order, read by `groupOrder`. */
  order: number;
  count: number;
  /** The column value its rows hold; `null` = the one "None" section. */
  value: FieldValue | null;
}

/** A grouping read, typed loosely: the column is checked by `resolveLiveFields`. */
type GroupsCollection = LiveCollection<
  Record<string, unknown>,
  Record<string, { domain: "text" }>,
  string
>;

export type GroupsResult = ResourceResult<readonly LiveGroup<unknown>[]>;

/**
 * The server's groups as the sections a view lists, in the order an in-memory
 * DataView would show them: each group's bucket from the field type's own
 * grouping (key, label and ordinal identical to grouping the rows in memory),
 * ordered by the ordinal read from `direction`'s end — never the server's
 * count order — and the one "None" last. A NULL group, and for a text column a
 * blank one, IS "None" (the filter language's `isEmpty`, which is also what
 * that section's own read selects), so a blank value never gets a section
 * that duplicates None's rows.
 *
 * Only a one-bucket-per-value grouping lowers here, so a bucketer that refuses
 * a value, or two values sharing a bucket, breaks its contract: a section read
 * selects ONE value. Both throw.
 */
export function serverSections(
  groups: readonly LiveGroup<unknown>[],
  ctx: {
    field: FieldDef<unknown>;
    grouping: FieldGrouping;
    column: LiveGroupColumn;
    now: number;
    direction: "asc" | "desc";
  },
): ServerSection[] {
  const { field, grouping, column, now, direction } = ctx;
  const isNone = (value: unknown) =>
    value === null ||
    filterDomains[column.domain].isEmpty(value as string | number | boolean);
  const values = groups
    .filter((g) => !isNone(g.value))
    .map((g) => g.value as FieldValue);
  const bucketOf = grouping.plan({ now, values, field });
  let noneCount = 0;
  const sections: (ServerSection & { seq: number })[] = [];
  const seen = new Set<string>();
  groups.forEach((group, seq) => {
    if (isNone(group.value)) {
      noneCount += group.count;
      return;
    }
    const value = group.value as FieldValue;
    const bucket = bucketOf(value);
    if (bucket === null) {
      throw new Error(
        `[data-view] grouping "${grouping.id}" (one bucket per value) refused the value ${JSON.stringify(value)} of "${column.name}" — a server section reads exactly one value, so every non-empty value must have its bucket.`,
      );
    }
    if (!Number.isFinite(bucket.order)) {
      throw new Error(
        `[data-view] grouping "${grouping.id}" gave bucket "${bucket.key}" a non-finite order (${String(bucket.order)}).`,
      );
    }
    if (seen.has(bucket.key)) {
      throw new Error(
        `[data-view] grouping "${grouping.id}" (one bucket per value) put two values of "${column.name}" in bucket "${bucket.key}" — a server section reads exactly one value.`,
      );
    }
    seen.add(bucket.key);
    sections.push({
      key: bucket.key,
      label: bucket.label,
      order: bucket.order,
      count: group.count,
      value,
      seq,
    });
  });
  const dir = direction === "desc" ? -1 : 1;
  sections.sort((a, b) => (a.order - b.order) * dir || a.seq - b.seq);
  const ordered: ServerSection[] = sections.map(({ seq: _seq, ...s }) => s);
  if (noneCount > 0) {
    ordered.push({
      key: NULL_GROUP_KEY,
      label: nullGroupLabel(field),
      order: 0,
      count: noneCount,
      value: null,
    });
  }
  return ordered;
}

/**
 * The rows of one section: the view's own `where`, AND its value — `eq`, or
 * for "None" `isEmpty` (NULL, and blank text, matching `serverSections`).
 */
export function sectionWhere(
  where: Filter | undefined,
  column: string,
  value: FieldValue | null,
  declared: Filterable,
): Filter {
  const own =
    value === null ? clause(column, "isEmpty") : clause(column, "eq", value);
  const filter = canonicalizeFilter(
    where === undefined ? and(own as Filter) : and(where, own as Filter),
    declared,
  );
  // A clause on the section's own value always constrains.
  if (filter === undefined) {
    throw new Error(
      `[data-view] the section filter on "${column}" canonicalized to no filter`,
    );
  }
  return filter;
}

/** One grouping read (renders nothing), its result reported up under `readKey`. */
export function GroupsRead(props: {
  source: LiveDataSource<unknown>;
  column: string;
  where: Filter | undefined;
  /** The exposed column sets the grouped column and `where` name (by wire name). */
  columns: readonly LiveColumnsDeclaration[];
  readKey: string;
  onResult: (readKey: string, result: GroupsResult) => void;
}): ReactNode {
  const { source, column, where, columns, readKey, onResult } = props;
  const collection = source.collection as unknown as GroupsCollection;
  const read = useLive(collection, {
    groupBy: column,
    ...(where === undefined
      ? {}
      : { where: where as LiveWhere<Record<string, { domain: "text" }>> }),
    limit: collection.groups.groups.maxLimit,
    ...(columns.length > 0 ? { columns } : {}),
  });
  useEffect(() => onResult(readKey, read), [onResult, readKey, read]);
  return null;
}

/** What one section's read reports: its rows so far, and how it pages. */
export interface SectionReport<TRow> {
  rows: readonly TRow[];
  paging: DataViewPaging<TRow>;
}

/** The section's query: everything but its `where` is the view's. */
export interface SectionQuery {
  where: Filter;
  orderBy: LiveOrderBy<string> | undefined;
  columns: readonly LiveColumnsDeclaration[];
}

/**
 * One section's own paged read (renders nothing), reported up. Keyed by
 * section, so a search typed into the list keeps its rows until the new head
 * settles (the read's own keep-previous handoff over the same `resetKey`).
 * Its pages follow the section's own rows on screen: the body reports them to
 * the section paging's `viewport` sink.
 */
export function SectionRead(props: {
  source: LiveDataSource<unknown>;
  sectionKey: string;
  query: SectionQuery;
  resetKey: string;
  onResult: (
    sectionKey: string,
    resetKey: string,
    report: SectionReport<unknown>,
  ) => void;
}): ReactNode {
  const { source, sectionKey, query, resetKey, onResult } = props;
  const pagesQuery = useMemo(
    () => ({
      where: query.where as LiveWhere<unknown>,
      ...(query.orderBy !== undefined ? { orderBy: query.orderBy } : {}),
      ...(query.columns.length > 0 ? { columns: query.columns } : {}),
    }),
    [query],
  );
  const { pages: read, paging } = useLivePagesPaging(
    source.collection,
    pagesQuery,
    { resetKey },
  );
  const report = useMemo((): SectionReport<unknown> => {
    switch (read.status) {
      case "loading":
        return { rows: NO_ROWS, paging: SECTION_LOADING };
      case "error":
        // The section's first page failed with nothing to show: its footer's
        // Retry re-reads it.
        return {
          rows: NO_ROWS,
          paging: {
            ...SECTION_LOADING,
            growing: false,
            stalled: { retry: () => void read.refetch() },
          },
        };
      case "ready":
        return { rows: read.rows, paging: paging! };
    }
  }, [read, paging]);
  useEffect(
    () => onResult(sectionKey, resetKey, report),
    [onResult, sectionKey, resetKey, report],
  );
  return null;
}

/** A section whose first page is on its way: the footer spins, nothing pages. */
const SECTION_LOADING: DataViewPaging<unknown> = {
  canGrow: false,
  growing: true,
  loadMore: () => {
    throw new Error("live-sections: loadMore() before the section settled");
  },
  complete: false,
  stalled: null,
  truncated: false,
  notices: [],
  viewport: NO_VIEWPORT,
  placeholders: NO_PLACEHOLDERS,
};

const NO_ROWS: readonly unknown[] = [];
