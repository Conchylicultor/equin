import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useDeferredLoadComplete } from "@plugins/framework/plugins/web-sdk/core";
import {
  and,
  canonicalizeFilter,
  filterColumns,
  FilterError,
  type Filter,
  type Filterable,
} from "@plugins/network/plugins/live/plugins/filter/core";
import type {
  LiveColumnsDeclaration,
  LiveCountedCollection,
  LiveOrderBy,
  LiveSortDirection,
  LiveWhere,
} from "@plugins/network/plugins/live/core";
import { useLive } from "@plugins/network/plugins/live/web";
import type { ResourceReadiness } from "@plugins/primitives/plugins/live-state/core";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import type {
  DataViewDeclaredSection,
  DataViewPaging,
  FieldDef,
  FieldGrouping,
  LiveDataSource,
  ViewState,
} from "../../core";
import {
  liveGroupLowering,
  renameColumns,
  type LiveFieldPlan,
  type LiveGroupColumn,
  type ResolveOperatorSet,
} from "./live-fields";
import {
  GroupsRead,
  SectionRead,
  sectionWhere,
  serverSections,
  type GroupsResult,
  type SectionQuery,
  type SectionReport,
} from "./live-sections";
import {
  lowerSearch,
  UnavailableFilterRuleError,
  UnavailableSortRuleError,
  useViewFilter,
} from "./live-filter";
import { NO_VIEWPORT } from "./pages-viewport";
import { NO_PLACEHOLDERS } from "./pages-paging";
import { useLivePagesPaging } from "./use-live-pages-paging";

// The DataView → live-window adapter (research/2026-09-29-global-scoped-change-routing.md,
// "P2 — DataView live-window adapter"; the pages:
// research/2026-10-09-global-live-key-range-pages-v2.md): a `source` DataView
// reads its collection as key-range pages (`useLive`) kept live by the
// rows it has on screen, with the view's sort, filter, search and group-by
// lowered onto the window query. Field ids stay the persisted vocabulary;
// `FieldDef.column` maps one to the collection column it reads.

/** The search box, debounced: each keystroke would otherwise mint, load and release a tuple. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/**
 * A live origin's answer, as the body renders it: one paged read partitioned
 * in memory (`flat`), or — grouped by a groupable column — sections the server
 * declared, each paging its own read (`sectioned`).
 */
export type SourceView<TRow> = FlatSourceView<TRow> | SectionedSourceView<TRow>;

interface SourceViewBase<TRow> {
  /** Every row loaded: the paged read's, or the open sections' reads, in section order. */
  rows: readonly TRow[];
  loading: boolean;
  /**
   * Why no query can be read — the view's own sort/filter/search lowering —
   * rendered in place of the view.
   */
  error: Error | null;
  /**
   * The read itself failed with nothing to show (a paged read's head): the
   * same arm a `readiness` read fails with, so it renders the same way — the
   * host's `errorState`, else `ResourceErrorInline` with Retry (and the reload
   * a stale tab needs).
   */
  readError: Extract<ResourceReadiness, { status: "error" }> | null;
}

/** One paged read over the whole query; any grouping partitions its loaded rows. */
export interface FlatSourceView<TRow> extends SourceViewBase<TRow> {
  kind: "flat";
  /** How the read pages; `complete` once every row of the query is loaded. */
  paging: DataViewPaging<TRow>;
  sectionOrder: "bucket" | "appearance";
}

/**
 * Grouped by a groupable column: the server lists every section with its
 * exact count (one `GROUP BY` read over the view's whole `where`), and each
 * section reads its own rows once it is expanded and its footer came into
 * view. `readError` is the groups read's; a section read's failure stays in
 * that section's footer.
 */
export interface SectionedSourceView<TRow> extends SourceViewBase<TRow> {
  kind: "sectioned";
  sections: readonly DataViewDeclaredSection<TRow>[];
  /** The groups read as the body's footer: it never pages, and says when it is full. */
  groupsPaging: DataViewPaging<TRow>;
  /** The reads behind it — the body renders this node (it draws nothing). */
  readers: ReactNode;
}

/**
 * A grouping under a sectioned origin that counts its groups under a filter
 * or search naming a contributed column — a `GROUP BY` reads the collection's
 * own columns only, so it cannot count them.
 */
export class UngroupableFilterError extends Error {
  constructor(column: string, contributed: readonly string[]) {
    super(
      `Grouping by "${column}" cannot count its sections under a filter on ${contributed.map((c) => `"${c}"`).join(", ")} — remove that rule, or group by another field.`,
    );
    this.name = "UngroupableFilterError";
  }
}

const SEARCH_DEBOUNCE_MS = 200;

/**
 * Read a live `source` for the active view: lower its sort, filter, search and
 * group-by onto key-range pages, and map the read onto the body's
 * `SourceView`. Always called; returns `null` without a source (the hook order
 * stays fixed). The body reports the rows it has on screen to the paging's
 * `viewport` sink, which keeps the pages near them live.
 *
 * - A saved rule on a field that does not resolve is PENDING while the
 *   deferred plugin tier is still loading (a contributor may not have
 *   registered its field yet), and the error arm once it settled.
 * - A search-only change keeps the previous rows until the new head settles;
 *   any other change (sort, filter, group, the midnight clock) starts over.
 * - Group-by lowers per `liveGroupLowering`: over a groupable column the
 *   view is SECTIONED (the server declares the sections, each pages its own
 *   read); a one-bucket-per-value grouping over a column that only sorts is
 *   prepended to the order and its sections follow row order; any other
 *   grouping partitions the loaded rows.
 */
export function useLiveSource<TRow>(args: {
  source: LiveDataSource<TRow> | undefined;
  plan: LiveFieldPlan<TRow> | null;
  fields: readonly FieldDef<TRow>[];
  state: ViewState;
  resolveOperatorSet: ResolveOperatorSet;
  resolveGrouping: (typeId: string, groupingId: string) => FieldGrouping;
  /** Local midnight — what a grouping plans against (`useGroupingClock`). */
  now: number;
  /** The view's collapsed group sections: a collapsed section reads nothing. */
  collapsedSections: ReadonlySet<string>;
}): SourceView<TRow> | null {
  const {
    source,
    plan,
    fields,
    state,
    resolveOperatorSet,
    resolveGrouping,
    now,
    collapsedSections,
  } = args;
  const deferredComplete = useDeferredLoadComplete();
  const query = useDebounced(state.query, SEARCH_DEBOUNCE_MS);

  // The view's filter, lowered over FIELD ids (relative dates against the day
  // clock), before its rename onto columns.
  const lowered = useViewFilter({
    group: plan ? state.filter : null,
    fields: plan?.filterFields ?? NO_FIELDS,
    resolveOperatorSet,
    filterable: plan?.filterable ?? NO_FILTERABLE,
  });

  const lowering = useMemo(():
    | { kind: "none" }
    | { kind: "pending" }
    | { kind: "error"; error: Error }
    | {
        kind: "ok";
        where: Filter | undefined;
        /** The query minus search — a change of it starts the read over. */
        resetKey: string;
        orderBy: LiveOrderBy<string> | undefined;
        /** The contributed-column handles the query names — the codec validates against them. */
        columns: readonly LiveColumnsDeclaration[];
        /** The collection's filterable columns plus the contributed ones named. */
        declared: Filterable;
        grouped: LoweredGrouping<TRow>;
        /**
         * The source's scope alone, when it is ALL the query filters by (no
         * view filter, no search) — the one `where` a total is read over;
         * `null` when the view narrows it.
         */
        totalWhere: { where: Filter | undefined } | null;
      } => {
    if (!source || !plan) return { kind: "none" };
    // The scope's value is not known yet: read nothing, show the loading state.
    if (source.scope.kind === "awaiting") return { kind: "pending" };
    const collection = source.collection;
    // The collection's own filterable columns, and every contributed one the
    // offered fields bind to (by wire name).
    const declared: Filterable = {
      ...(collection.filterable as unknown as Filterable),
      ...Object.assign(
        {},
        ...[...plan.handles.values()].map((h) => h.wireFilterable),
      ),
    };
    const unavailable = (error: Error) =>
      deferredComplete
        ? { kind: "error" as const, error }
        : { kind: "pending" as const };

    // Sort: each rule's column; a rule on no sortable column is unavailable.
    const sortable = new Set(plan.sortFields.map((f) => f.id));
    const missing = state.sort
      .filter((r) => !sortable.has(r.fieldId))
      .map((r) => r.fieldId);
    if (missing.length > 0) {
      return unavailable(new UnavailableSortRuleError(missing));
    }
    if (lowered.kind === "error") {
      return lowered.error instanceof UnavailableFilterRuleError
        ? unavailable(lowered.error)
        : { kind: "error", error: lowered.error };
    }
    const columnOf = (fieldId: string) => plan.columnOf.get(fieldId)!;
    let order: [string, LiveSortDirection][] =
      state.sort.length > 0
        ? state.sort.map((r) => [columnOf(r.fieldId), r.direction])
        : collection.window.window.defaultOrderBy.map(
            ([c, d]) => [c, d] as [string, LiveSortDirection],
          );
    // Group-by, as `liveGroupLowering` says: server sections over a
    // groupable column; over a column that only sorts, a one-bucket-per-value
    // grouping leads the order so its sections are contiguous in row order.
    let grouped: LoweredGrouping<TRow> = {
      kind: "rows",
      sectionOrder: "bucket",
    };
    const groupField = state.groupBy
      ? fields.find((f) => f.id === state.groupBy!.fieldId)
      : undefined;
    if (state.groupBy && groupField) {
      const grouping = resolveGrouping(
        groupField.type ?? "text",
        state.groupBy.groupingId,
      );
      const dir =
        state.sort.find((r) => r.fieldId === groupField.id)?.direction ?? "asc";
      const lowering = liveGroupLowering(plan, groupField, grouping);
      switch (lowering.kind) {
        case "sections":
          grouped = {
            kind: "sections",
            column: lowering.column,
            field: groupField,
            grouping,
            direction: dir,
          };
          break;
        case "prefix":
          if (order[0]?.[0] !== lowering.column) {
            order = [[lowering.column, dir], ...order];
          }
          grouped = { kind: "rows", sectionOrder: "appearance" };
          break;
        case "buckets":
        case "none":
          // `none` is never offered by the Group-by control; a saved one
          // (authored config) partitions what is loaded, as before.
          break;
        default:
          lowering satisfies never;
      }
    }
    // A column named twice (the prepend, or two fields on one column): the
    // codec refuses a duplicate, and the second can never reorder anything.
    const seen = new Set<string>();
    order = order.filter(([c]) => !seen.has(c) && seen.add(c) !== undefined);

    const renamed =
      lowered.filter === undefined
        ? undefined
        : renameColumns(lowered.filter, columnOf);
    const search = lowerSearch(query, source.searchable, declared);
    const scope =
      source.scope.kind === "where" ? source.scope.filter : undefined;
    const base = [scope, renamed].filter((f): f is Filter => f !== undefined);
    const parts = search === undefined ? base : [...base, search];
    let where: Filter | undefined;
    try {
      where =
        parts.length === 0
          ? undefined
          : canonicalizeFilter(and(...parts), declared);
      // The reset key's filter, without the search: canonicalized the same way.
      const resetWhere =
        base.length === 0
          ? undefined
          : canonicalizeFilter(and(...base), declared);
      // The contributors whose columns the query names (by wire name).
      const named = new Set([
        ...(where === undefined ? [] : filterColumns(where)),
        ...order.map(([c]) => c),
      ]);
      // A sectioned view's section reads name the grouped column too.
      if (grouped.kind === "sections") named.add(grouped.column.name);
      const columns = [...plan.handles.values()].filter((h) =>
        [...named].some((c) => c.startsWith(`${h.name}.`)),
      );
      if (grouped.kind === "sections" && where !== undefined) {
        // A `GROUP BY` counts over the collection's own and exposed columns
        // only — never a contributed one.
        const contributed = [...filterColumns(where)].filter((c) =>
          [...plan.handles.values()].some(
            (h) => h.owner.kind !== "exposed" && c.startsWith(`${h.name}.`),
          ),
        );
        if (contributed.length > 0) {
          return {
            kind: "error",
            error: new UngroupableFilterError(grouped.column.name, contributed),
          };
        }
      }
      return {
        kind: "ok",
        where,
        orderBy: order,
        columns,
        declared,
        grouped,
        totalWhere:
          renamed === undefined && search === undefined
            ? { where: scope }
            : null,
        resetKey: JSON.stringify({
          where: resetWhere ?? null,
          order,
          group:
            grouped.kind === "sections" ? grouped.column.name : grouped.kind,
        }),
      };
    } catch (err) {
      if (!(err instanceof FilterError)) throw err;
      return { kind: "error", error: err };
    }
  }, [
    source,
    plan,
    fields,
    state.sort,
    state.groupBy,
    lowered,
    query,
    deferredComplete,
    resolveGrouping,
  ]);

  const pagesQuery = useMemo(
    () =>
      lowering.kind === "ok" && lowering.grouped.kind === "rows"
        ? {
            ...(lowering.where !== undefined
              ? { where: lowering.where as LiveWhere<unknown> }
              : {}),
            ...(lowering.orderBy !== undefined
              ? { orderBy: lowering.orderBy }
              : {}),
            ...(lowering.columns.length > 0
              ? { columns: lowering.columns }
              : {}),
          }
        : null,
    [lowering],
  );
  const { pages, paging: pagesPaging } = useLivePagesPaging(
    // No source, or a sectioned view (each section reads its own): a
    // detached read, which reads nothing.
    pagesQuery === null ? null : (source?.collection ?? null),
    pagesQuery,
    lowering.kind === "ok" ? { resetKey: lowering.resetKey } : undefined,
  );
  const sectionedLowering = useMemo(
    (): SectionedLowering<TRow> | null =>
      lowering.kind === "ok" && lowering.grouped.kind === "sections"
        ? { ...lowering, grouped: lowering.grouped }
        : null,
    [lowering],
  );
  const sectioned = useSectionedReads<TRow>({
    source,
    lowering: sectionedLowering,
    now,
    collapsedSections,
  });

  // The total, when cheap: a collection declared `count: true`, read over the
  // source's scope alone — under a view filter or a search it is not read, and
  // the counts stay lower bounds. A sectioned view reads none: its sections'
  // counts are the groups read's.
  const counted =
    source && source.collection.count !== null
      ? (source.collection as unknown as LiveCountedCollection<
          TRow,
          unknown,
          string
        >)
      : null;
  const totalWhere =
    counted !== null &&
    lowering.kind === "ok" &&
    lowering.grouped.kind === "rows"
      ? lowering.totalWhere
      : null;
  const total = useLive(
    counted,
    totalWhere === null
      ? null
      : {
          count: true,
          ...(totalWhere.where !== undefined
            ? { where: totalWhere.where as LiveWhere<unknown> }
            : {}),
        },
  );
  // Not known yet, or failed with nothing seen: no total — the counts stay
  // lower bounds, which are still true (the failure is the read's to report).
  const totalCount = foldResource(total, {
    ready: (n) => n,
    loading: () => null,
    error: (_error, stale) => stale ?? null,
  });

  const settled =
    pages.status === "loading" || pages.status === "error" ? null : pages;
  const rows = (settled?.rows ?? NO_ROWS) as readonly TRow[];
  const paging = useMemo(
    () =>
      pagesPaging === null
        ? NOT_PAGING
        : {
            ...pagesPaging,
            total: totalCount === null ? null : { count: totalCount },
          },
    [pagesPaging, totalCount],
  );

  if (!source) return null;
  if (lowering.kind === "error") {
    return {
      kind: "flat",
      rows: NO_ROWS as readonly TRow[],
      loading: false,
      error: lowering.error,
      readError: null,
      paging: NOT_PAGING as DataViewPaging<TRow>,
      sectionOrder: "bucket",
    };
  }
  if (sectioned !== null) return sectioned;
  return {
    kind: "flat",
    rows,
    loading: lowering.kind !== "ok" || pages.status === "loading",
    error: null,
    readError: pages.status === "error" ? pages : null,
    paging: paging as DataViewPaging<TRow>,
    sectionOrder:
      lowering.kind === "ok" && lowering.grouped.kind === "rows"
        ? lowering.grouped.sectionOrder
        : "bucket",
  };
}

/** How the view's group-by lowered. */
type LoweredGrouping<TRow> =
  | { kind: "rows"; sectionOrder: "bucket" | "appearance" }
  | SectionsGrouping<TRow>;

interface SectionsGrouping<TRow> {
  kind: "sections";
  column: LiveGroupColumn;
  field: FieldDef<TRow>;
  grouping: FieldGrouping;
  /** The view's sort direction on the grouped field — which end the sections read from. */
  direction: "asc" | "desc";
}

/** The lowering a sectioned view reads with. */
interface SectionedLowering<TRow> {
  where: Filter | undefined;
  orderBy: LiveOrderBy<string> | undefined;
  columns: readonly LiveColumnsDeclaration[];
  declared: Filterable;
  resetKey: string;
  grouped: SectionsGrouping<TRow>;
}

/**
 * The reads of a sectioned view, and its answer (`null` when the view is not
 * sectioned). The groups read and every open section's read are sibling
 * components (`readers`) reporting up here:
 *
 * - the groups read's latest ready answer is kept while a SEARCH-only change
 *   re-reads it (same `resetKey`), so typing never flashes the skeleton;
 * - a section is ACTIVE once its footer asked for its first page (it was
 *   expanded and came into view) and while it is not collapsed — the latch
 *   resets when the query does (`resetKey`). An inactive section reads
 *   nothing; its paging's `loadMore` is what activates it.
 */
function useSectionedReads<TRow>(args: {
  source: LiveDataSource<TRow> | undefined;
  lowering: SectionedLowering<TRow> | null;
  now: number;
  collapsedSections: ReadonlySet<string>;
}): SectionedSourceView<TRow> | null {
  const { source, lowering, now, collapsedSections } = args;
  const resetKey = lowering?.resetKey ?? null;
  // What the groups read is OF — the column and the whole `where`, search
  // included — and the query (minus search) it belongs to. A report under
  // another key is a previous read's.
  const groupsKey =
    lowering === null
      ? null
      : JSON.stringify([
          lowering.grouped.column.name,
          lowering.where ?? null,
          lowering.resetKey,
        ]);

  const [groups, setGroups] = useState<{
    key: string | null;
    result: GroupsResult | null;
    /** The last ready answer, and the query (minus search) it answered. */
    lastReady: { resetKey: string; result: GroupsReady } | null;
  }>({ key: null, result: null, lastReady: null });
  const onGroups = useCallback(
    (key: string, result: GroupsResult) =>
      setGroups((prev) => {
        const reset = (JSON.parse(key) as [string, unknown, string])[2];
        return {
          key,
          result,
          lastReady:
            result.status === "ready"
              ? { resetKey: reset, result }
              : prev.lastReady,
        };
      }),
    [],
  );

  // Which sections asked to be read, under which query.
  const [activated, setActivated] = useState<{
    resetKey: string | null;
    keys: ReadonlySet<string>;
  }>({ resetKey: null, keys: NO_KEYS });
  const activate = useCallback(
    (key: string) =>
      setActivated((prev) => {
        const base = prev.resetKey === resetKey ? prev.keys : NO_KEYS;
        if (prev.resetKey === resetKey && base.has(key)) return prev;
        return { resetKey, keys: new Set([...base, key]) };
      }),
    [resetKey],
  );
  const latched = activated.resetKey === resetKey ? activated.keys : NO_KEYS;

  const [reports, setReports] = useState<
    ReadonlyMap<string, { resetKey: string; report: SectionReport<unknown> }>
  >(() => new Map());
  const onSection = useCallback(
    (sectionKey: string, reset: string, report: SectionReport<unknown>) =>
      setReports((prev) => {
        const held = prev.get(sectionKey);
        if (held?.resetKey === reset && held.report === report) return prev;
        const next = new Map(prev);
        next.set(sectionKey, { resetKey: reset, report });
        return next;
      }),
    [],
  );

  // The groups this render shows: the current read's answer once it has one
  // (a failure included), else — while a search-only change re-reads them —
  // the last ready answer to this query.
  const current = groups.key === groupsKey ? groups.result : null;
  const lastReady =
    groups.lastReady !== null && groups.lastReady.resetKey === resetKey
      ? groups.lastReady.result
      : null;
  const shown: GroupsResult | null =
    current !== null && current.status !== "loading"
      ? current
      : (lastReady ?? current);

  const declared = useMemo(() => {
    if (lowering === null || shown?.status !== "ready") return null;
    return serverSections(shown.data, {
      field: lowering.grouped.field as FieldDef<unknown>,
      grouping: lowering.grouped.grouping,
      column: lowering.grouped.column,
      now,
      direction: lowering.grouped.direction,
    });
  }, [lowering, shown, now]);

  // Each declared section's query (stable per section while the query is).
  const queries = useMemo(() => {
    const out = new Map<string, SectionQuery>();
    if (lowering === null || declared === null) return out;
    for (const section of declared) {
      out.set(section.key, {
        where: sectionWhere(
          lowering.where,
          lowering.grouped.column.name,
          section.value,
          lowering.declared,
        ),
        orderBy: lowering.orderBy,
        columns: lowering.columns,
      });
    }
    return out;
  }, [lowering, declared]);

  const active = useMemo(
    () =>
      new Set(
        [...latched].filter(
          (key) => queries.has(key) && !collapsedSections.has(key),
        ),
      ),
    [latched, queries, collapsedSections],
  );

  const sections = useMemo((): DataViewDeclaredSection<TRow>[] => {
    if (declared === null) return [];
    return declared.map((section) => {
      const isActive = active.has(section.key);
      const held = isActive ? reports.get(section.key) : undefined;
      const report =
        held !== undefined && held.resetKey === resetKey ? held.report : null;
      return {
        key: section.key,
        label: section.label,
        count: section.count,
        rows: (report?.rows ?? NO_ROWS) as readonly TRow[],
        paging: (isActive
          ? (report?.paging ?? SECTION_PENDING)
          : unreadPaging(() => activate(section.key))) as DataViewPaging<TRow>,
      };
    });
  }, [declared, active, reports, resetKey, activate]);

  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const full =
    shown?.status === "ready" &&
    source !== undefined &&
    shown.data.length >= source.collection.groups.groups.maxLimit;
  const groupsPaging = useMemo(
    (): DataViewPaging<TRow> => ({
      ...(NOT_PAGING as DataViewPaging<TRow>),
      complete: !full,
      truncated: full ? { hint: GROUPS_TRUNCATED_HINT } : false,
    }),
    [full],
  );

  if (lowering === null || source === undefined || groupsKey === null) {
    return null;
  }
  const readers = (
    <>
      <GroupsRead
        source={source as LiveDataSource<unknown>}
        column={lowering.grouped.column.name}
        where={lowering.where}
        columns={lowering.columns}
        readKey={groupsKey}
        onResult={onGroups}
      />
      {[...active].map((key) => (
        <SectionRead
          key={key}
          source={source as LiveDataSource<unknown>}
          sectionKey={key}
          query={queries.get(key)!}
          resetKey={lowering.resetKey}
          onResult={onSection}
        />
      ))}
    </>
  );
  return {
    kind: "sectioned",
    rows,
    sections,
    groupsPaging,
    readers,
    loading: shown === null || shown.status === "loading",
    error: null,
    readError: shown?.status === "error" ? shown : null,
  };
}

type GroupsReady = Extract<GroupsResult, { status: "ready" }>;

/**
 * A section not read yet: its footer's first sighting asks for a page, which
 * starts its read. `canGrow` keeps the sentinel up; nothing is loading.
 */
function unreadPaging(activate: () => void): DataViewPaging<unknown> {
  return {
    canGrow: true,
    growing: false,
    loadMore: activate,
    complete: false,
    stalled: null,
    truncated: false,
    notices: [],
    viewport: NO_VIEWPORT,
    placeholders: NO_PLACEHOLDERS,
  };
}

/** An active section whose read has not reported yet: the footer spins. */
const SECTION_PENDING: DataViewPaging<unknown> = {
  canGrow: false,
  growing: true,
  loadMore: () => {
    throw new Error("live-source: a section's loadMore() before it reported");
  },
  complete: false,
  stalled: null,
  truncated: false,
  notices: [],
  viewport: NO_VIEWPORT,
  placeholders: NO_PLACEHOLDERS,
};

const GROUPS_TRUNCATED_HINT =
  "the smallest groups are not listed; narrow the filter to see them";
const NO_KEYS: ReadonlySet<string> = new Set();

/** A read with nothing settled yet: no page to ask for, and not complete. */
const NOT_PAGING: DataViewPaging<unknown> = {
  canGrow: false,
  growing: false,
  loadMore: () => {
    throw new Error("live-source: loadMore() before the read settled");
  },
  complete: false,
  stalled: null,
  truncated: false,
  notices: [],
  viewport: NO_VIEWPORT,
  placeholders: NO_PLACEHOLDERS,
};

const NO_FIELDS: FieldDef<never>[] = [];
const NO_FILTERABLE: Filterable = {};
const NO_ROWS: readonly unknown[] = [];
