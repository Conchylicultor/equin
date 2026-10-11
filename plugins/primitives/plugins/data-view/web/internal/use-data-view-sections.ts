import { useMemo } from "react";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  atLeastCount,
  exactCount,
  type DataViewAggregateConfig,
  type DataViewRowEntry,
  type DataViewRowsComplete,
  type DataViewSection,
  type DataViewSectioning,
  type FieldDef,
  type FieldGrouping,
  type FieldValue,
  type FilterOperatorSet,
  type GroupByRule,
  type SectionCount,
  type ViewState,
} from "../../core";
import { useGroupingRegistry } from "../grouping-slot";
import { IDENTITY_GROUPING } from "./identity-grouping";
import { useFlatRows } from "./use-flat-rows";
import { foldSections, makeFoldKeep } from "./fold-sections";
import { useRowFilter } from "./use-row-filter";

/** Sentinel bucket key for rows whose group-by value is null/undefined. Holds a
 *  control char so it can never collide with a real stringified field value.
 *  A live source's declared "None" section uses it too, so a collapsed "None"
 *  stays collapsed whichever way the sections were computed. */
export const NULL_GROUP_KEY = " __dataview_none__";

/** The one label of the one "None" section. */
export const NULL_GROUP_LABEL = "None";

/**
 * Default groupable policy: a field with a `value` projection **whose type says
 * how it buckets** (mirrors `sortable` defaulting off `value`). Overridable
 * per-field via `FieldDef.groupable`.
 *
 * `hasGrouping` is injected — a `(typeId) => boolean` read of the `Grouping`
 * slot (`useGroupingRegistry().has`). This function used to spell
 * `type === "enum" || type === "bool"`, a literal type list living inside the
 * primitive; groupability is now derived from what the field TYPES declare, so
 * adding a groupable type is a contribution and never an edit here.
 */
export function isGroupableField<TRow>(
  field: FieldDef<TRow>,
  hasGrouping: (typeId: string) => boolean,
): boolean {
  if (!field.value) return false;
  return field.groupable ?? hasGrouping(field.type ?? "text");
}

/** What `partitionIntoSections` needs beyond the rows: the injected grouping
 *  resolver, the injected clock, and the reading direction. */
export interface PartitionOptions<TRow = unknown> {
  /**
   * `(typeId, groupingId) => FieldGrouping` — resolve the grouping a
   * `GroupByRule` names for a field of this type. Injected so the partition
   * stays a pure function that reads no slot registry (and can be unit-tested
   * with a stub), and so that data-view never names a field type.
   */
  resolveGrouping: (typeId: string, groupingId: string) => FieldGrouping;
  /** Local midnight of the current day (see `useGroupingClock`). */
  now: number;
  /**
   * Section reading direction, taken from the view's own sort on the grouped
   * field. `GroupBucket.order` is always a plain ascending ordinal; this decides
   * which end it is read from. The "None" bucket stays LAST in both directions —
   * it holds no position on the ordinal, so reversing it would mean nothing.
   */
  order: "asc" | "desc";
  /**
   * Whether `rows` is the whole set (`DataViewRenderProps.rowsComplete`).
   * Absent ⇒ true (in memory). When not, a section's count is a lower bound
   * unless a later section has started (under `"appearance"` order) — or, for
   * `{ growable }`, unless the section holds no growable row, or the read's
   * `total` makes it exact (see {@link sectionCount}).
   */
  rowsComplete?: DataViewRowsComplete<TRow>;
  /**
   * Where the sections come from (`DataViewRenderProps.sectioning`). Absent ⇒
   * `bucket`. `appearance` — sections follow first appearance in `rows`, which
   * the server sorted by the grouped column first; `declared` — the server
   * listed them, each with its own rows (`rows` is then not read).
   */
  sectioning?: DataViewSectioning<TRow>;
}

/**
 * Pure partition step (testable without React): bucket the already
 * search→filter→sort-processed `rows` by the `groupBy` rule's field into ordered
 * sections. When `groupBy` is unset, or names a field with no `value`
 * projection, returns exactly ONE `{ key: null }` section mapping rows 1:1 — so
 * the un-grouped render is byte-for-byte identical to the old flat path.
 *
 * **It names no field type.** A bucket's key, label and ordinal all come from
 * the `FieldGrouping` the rule names — which the field's own type contributed —
 * so a date bucketing into "Later this week" and an enum bucketing by option
 * order reach here through one code path. Within a section, the incoming
 * (sorted) row order is preserved.
 */
export function partitionIntoSections<TRow>(
  rows: readonly TRow[],
  fields: FieldDef<TRow>[],
  groupBy: GroupByRule | undefined,
  rowKey: (row: TRow, index: number) => string,
  opts: PartitionOptions<TRow>,
): DataViewSection<TRow>[] {
  const field = groupBy
    ? fields.find((f) => f.id === groupBy.fieldId)
    : undefined;

  const completeness = opts.rowsComplete ?? true;
  // Ungrouped (or an unresolvable/value-less group field): one implicit section.
  if (!groupBy || !field?.value) {
    return [
      {
        key: null,
        count: sectionCount(rows, rows, completeness, null),
        entries: rows.map((row, i) => ({ row, key: rowKey(row, i) })),
      },
    ];
  }

  // Declared by the server: every section it listed, in its order, with the
  // rows of its own read — an empty one too (its header, count and footer are
  // what start its read). The count is the server's, so it is exact.
  if (opts.sectioning?.kind === "declared") {
    let index = 0;
    return opts.sectioning.sections.map((declared) => ({
      key: declared.key,
      label: declared.label,
      count: exactCount(declared.count),
      entries: declared.rows.map((row) => ({
        row,
        key: rowKey(row, index++),
      })),
      paging: declared.paging,
    }));
  }

  // Project once: the plan phase needs the whole value set before it can order
  // its sections, and re-projecting per row afterwards would run the consumer's
  // accessor twice.
  const project = field.value;
  const values = rows.map((row) => project(row));
  const grouping = opts.resolveGrouping(
    field.type ?? "text",
    groupBy.groupingId,
  );
  const bucketOf = grouping.plan({
    now: opts.now,
    values: values.filter((v) => v != null),
    field: field as FieldDef<unknown>,
  });

  // `seq` is the bucket's discovery order — the tie-break that keeps two buckets
  // sharing an ordinal in a stable order in BOTH reading directions.
  interface Bucket {
    label: string;
    order: number;
    seq: number;
    rows: TRow[];
  }
  const buckets = new Map<string, Bucket>();
  // The ONE catch-all: no value, and a value the grouping cannot bucket. Both
  // read as "None" to the user, and giving them one section is what stops a
  // grouping from minting a rival "None" with an ordinal of its own.
  const nullBucket: Bucket = {
    label: NULL_GROUP_LABEL,
    order: 0,
    seq: -1,
    rows: [],
  };
  rows.forEach((row, i) => {
    const value = values[i] as FieldValue;
    const bucketed = value == null ? null : bucketOf(value);
    if (!bucketed) {
      nullBucket.rows.push(row);
      return;
    }
    const { key, label, order } = bucketed;
    let bucket = buckets.get(key);
    if (!bucket) {
      // Checked once per bucket, not per row. A non-finite ordinal is only ever
      // reached for as "put this last", which it does not do — `Infinity - n` is
      // `Infinity`, so it pins last ascending and FIRST descending, and two of
      // them subtract to `NaN`. A bucket with no position is not a bucket; the
      // bucketer returns `null` for that and the row joins "None" above.
      if (!Number.isFinite(order)) {
        throw new Error(
          `[data-view] grouping "${grouping.id}" gave bucket "${key}" a non-finite order ` +
            `(${String(order)}). Return null from the bucketer for a value you cannot ` +
            `bucket — it joins the "None" section, which is ordered last in both directions.`,
        );
      }
      bucket = { label, order, seq: buckets.size, rows: [] };
      buckets.set(key, bucket);
    }
    bucket.rows.push(row);
  });

  const dir = opts.order === "desc" ? -1 : 1;
  const byAppearance = opts.sectioning?.kind === "appearance";
  // In row order, a section's first row is where the server's sort placed it;
  // otherwise the bucket's ordinal decides, discovery order breaking ties.
  const ordered: [string, Bucket][] = [...buckets.entries()].sort(
    ([, a], [, b]) =>
      byAppearance ? a.seq - b.seq : (a.order - b.order) * dir || a.seq - b.seq,
  );
  // "None" is not a point on the ordinal — it is the absence of one — so it
  // trails the real sections whichever way they read.
  if (nullBucket.rows.length > 0) ordered.push([NULL_GROUP_KEY, nullBucket]);

  // Index counter is global across sections so `rowKey(row, index)` stays
  // stable and unique even when the consumer's key depends on the index.
  let globalIndex = 0;
  return ordered.map(([key, bucket], i) => ({
    key,
    label: bucket.label,
    // Exact when every row is loaded — or, sections in row order, when a later
    // section has started: a later page can only add sections after the tail.
    count:
      byAppearance && i < ordered.length - 1
        ? exactCount(bucket.rows.length)
        : sectionCount(bucket.rows, rows, completeness, {
            fieldId: field.id,
          }),
    entries: bucket.rows.map((row) => ({
      row,
      key: rowKey(row, globalIndex++),
    })),
  }));
}

/**
 * One section's count: exact when it holds every row it can (`rowsComplete`
 * true, or no growable row); else exact from the paged read's `total` when the
 * read's unloaded rows can only land here — the section holds every loaded
 * growable row and the view is ungrouped or grouped by a `uniform` field;
 * else a lower bound.
 * Never below the rows it holds (a total a write ago).
 */
function sectionCount<TRow>(
  sectionRows: readonly TRow[],
  allRows: readonly TRow[],
  completeness: DataViewRowsComplete<TRow>,
  /** The section's grouped field; `null` ungrouped. */
  group: { fieldId: string } | null,
): SectionCount {
  const n = sectionRows.length;
  if (completeness === true) return exactCount(n);
  if (completeness === false) return atLeastCount(n);
  const { growable, total } = completeness;
  const paged = sectionRows.filter(growable).length;
  if (paged === 0) return exactCount(n);
  if (total === null) return atLeastCount(n);
  const others = n - paged;
  const holdsAll = paged === allRows.filter(growable).length;
  if (
    holdsAll &&
    (group === null || (total.uniform ?? []).includes(group.fieldId))
  ) {
    return exactCount(Math.max(n, others + total.count));
  }
  return atLeastCount(n);
}

/**
 * Pure aggregate step (testable without React): collapse, **within each
 * section**, the entries sharing a non-null `getKey` into ONE representative
 * entry. Runs AFTER group + manual-order ordering, so it aggregates the
 * already-ordered entries.
 *
 * - A non-null key emits one entry with `row = pickRepresentative(members)`
 *   (default: the first member in current order), `aggregateCount = members.length`,
 *   and `members` = every collapsed row. The representative entry keeps the
 *   **position of the first member** in the current order, and carries that first
 *   member's `key` (so the entry id is stable as members shift). When the picked
 *   representative differs from the first member the entry still uses the first
 *   member's `key` — the entry stands for the group, not a single row.
 * - A `null` key passes through 1:1 (no `aggregateCount`/`members`).
 *
 * `section.count` becomes the post-collapse entry count — the rows the user
 * sees, not the members behind them — keeping its kind: a lower bound stays
 * one, since a later page can add entries (or only members) but never remove one.
 * A count that also covers rows not loaded yet (a paged read's known total)
 * keeps them — unless loaded rows collapsed: the unloaded ones might too, so
 * the entries seen are only a lower bound.
 */
export function aggregateSections<TRow>(
  sections: DataViewSection<TRow>[],
  aggregate: DataViewAggregateConfig<TRow>,
): DataViewSection<TRow>[] {
  const pick = aggregate.pickRepresentative ?? ((members) => members[0]!);
  return sections.map((section) => {
    // Reserve one output slot per non-null key at its first member's position;
    // null-key entries pass straight through.
    const buckets = new Map<
      string,
      { entries: DataViewRowEntry<TRow>[]; slot: number }
    >();
    const out: DataViewRowEntry<TRow>[] = [];
    for (const entry of section.entries) {
      const key = aggregate.getKey(entry.row);
      if (key == null) {
        out.push({ row: entry.row, key: entry.key });
        continue;
      }
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.entries.push(entry);
      } else {
        const slot = out.length;
        out.push(entry); // placeholder, rewritten below
        buckets.set(key, { entries: [entry], slot });
      }
    }
    for (const { entries, slot } of buckets.values()) {
      const members = entries.map((e) => e.row);
      out[slot] = {
        row: pick(members),
        key: entries[0]!.key,
        aggregateCount: members.length,
        members,
      };
    }
    const unloaded = section.count.n - section.entries.length;
    const collapsed = section.entries.length - out.length;
    return {
      ...section,
      count:
        unloaded > 0 && collapsed > 0
          ? atLeastCount(out.length)
          : { kind: section.count.kind, n: out.length + Math.max(0, unloaded) },
      entries: out,
    };
  });
}

/**
 * Pure manual-order step (testable without React): order each section's entries
 * by `manualRank`, WITHIN the section. Sections are HOMOGENEOUS — a section is
 * either all-ranked or all-null (the consumer guarantees it via its group-by
 * classification) — so a `0`-returning comparator on an all-null section is a
 * stable no-op = "keep incoming order" (Array.sort is stable in ES2019+). A
 * `null` rank on either side yields `0`; mixed null/non-null within one section
 * is under-specified and never produced by consumers.
 */
export function orderSectionsByRank<TRow>(
  sections: DataViewSection<TRow>[],
  manualRank: (row: TRow) => Rank | null,
): DataViewSection<TRow>[] {
  return sections.map((section) => ({
    ...section,
    entries: [...section.entries].sort((a, b) => {
      const ra = manualRank(a.row);
      const rb = manualRank(b.row);
      if (ra == null || rb == null) return 0;
      return Rank.compare(ra, rb);
    }),
  }));
}

/**
 * The unifying section pipeline every flat view (`list`/`table`/`gallery`)
 * renders against. Wraps `useFlatRows` (search→filter→sort — UNCHANGED), then
 * partitions the result by `state.groupBy`, orders each section by `manualRank`
 * (Sub-task 2), and finally collapses aggregate groups within each section
 * (Sub-task 3, via `opts.aggregate`). Absent `aggregate` → entries map rows 1:1.
 *
 * `opts` is REQUIRED because `now` and `groupOrder` are: both come from the host
 * (`DataViewRenderProps`), which is the one place that can quantize the clock
 * once per surface and read the view's own sort. A view that defaulted them
 * would be reading the clock implicitly and guessing the direction.
 */
export function useDataViewSections<TRow>(
  rows: readonly TRow[],
  fields: FieldDef<TRow>[],
  state: ViewState,
  resolveOperatorSet: (typeId: string) => FilterOperatorSet | undefined,
  searchAccessor: ((row: TRow) => string) | undefined,
  opts: {
    rowKey?: (row: TRow, index: number) => string;
    /**
     * Aggregating-sections (Sub-task 3): when supplied, entries sharing a
     * non-null `getKey` collapse into one representative entry per section
     * (after group + manual-order ordering). Absent → entries map rows 1:1.
     */
    aggregate?: DataViewAggregateConfig<TRow>;
    /**
     * Flat manual-order seam (Sub-task 2): when supplied, the field sort is
     * skipped (search/filter still run) and each section's entries are ordered
     * by this `Rank` instead — the flat analog of the tree ignoring sort.
     * Returning `null` for a row marks it non-orderable (keeps incoming order).
     */
    manualRank?: (row: TRow) => Rank | null;
    /** `DataViewRenderProps.now` — local midnight, quantized by the host. */
    now: number;
    /** `DataViewRenderProps.groupOrder` — the section reading direction. */
    groupOrder: "asc" | "desc";
    /** `DataViewRenderProps.rowsComplete` — whether section counts may be exact. */
    rowsComplete: DataViewRowsComplete<TRow>;
    /** `DataViewRenderProps.sectioning` — where grouped sections come from. */
    sectioning: DataViewSectioning<TRow>;
    /**
     * `DataViewRenderProps.foldLines?.open` — the section keys whose fold line is
     * open. The fold rule itself is read off `state.fold` (which the host already
     * cleared while a search is typed); absent rule ⇒ nothing folds.
     */
    openFolds?: ReadonlySet<string>;
    /** `DataViewRenderProps.selectedRowId` — the selected row is never folded. */
    selectedRowId?: string;
  },
): DataViewSection<TRow>[] {
  const manualRank = opts.manualRank;
  // Manual order ignores the field sort (orders by rank below) — zero out `sort`
  // before the flat pipeline so search/filter still run but the sort step no-ops.
  const flatState = useMemo(
    () => (manualRank ? { ...state, sort: [] } : state),
    [manualRank, state],
  );
  const flat = useFlatRows(
    rows,
    fields,
    flatState,
    resolveOperatorSet,
    searchAccessor,
  );
  const rowKey = opts.rowKey;
  const aggregate = opts.aggregate;
  const {
    now,
    groupOrder,
    openFolds,
    selectedRowId,
    rowsComplete,
    sectioning,
  } = opts;
  const fold = state.fold;
  // The fold rule's `keep` tree, lowered once per (tree, clock) like the filter.
  const matchesKeep = useRowFilter(
    fold?.keep ?? null,
    fields,
    resolveOperatorSet,
  );
  const resolveGrouping = useGroupingRegistry().resolve;
  // A stored rule carries its `groupingId` (`readGroupBy` defaults it), but a
  // view handed a hand-built state may omit it — fill the identity grouping.
  // `state` is stable per view (`stateFor` is a ViewGetter), so this memo holds.
  const storedGroupBy = state.groupBy;
  const groupBy = useMemo(
    () =>
      storedGroupBy && !storedGroupBy.groupingId
        ? { ...storedGroupBy, groupingId: IDENTITY_GROUPING.id }
        : storedGroupBy,
    [storedGroupBy],
  );
  return useMemo(() => {
    let sections = partitionIntoSections(
      flat,
      fields,
      groupBy,
      rowKey ?? ((_row: TRow, i: number) => String(i)),
      { resolveGrouping, now, order: groupOrder, rowsComplete, sectioning },
    );
    // Order each section's entries by rank (within-section manual order) BEFORE
    // aggregating, so the representative defaults to the first rank-ordered member.
    if (manualRank) sections = orderSectionsByRank(sections, manualRank);
    // Collapse aggregate groups within each (already-ordered) section.
    if (aggregate) sections = aggregateSections(sections, aggregate);
    // Fold LAST, so it counts the entries the user sees (an aggregate's
    // representative decides) and pulls folded rows from wherever they sort.
    if (fold) {
      const key = rowKey ?? ((_row: TRow, i: number) => String(i));
      sections = foldSections(sections, {
        isKept: makeFoldKeep(matchesKeep, {
          selectedRowId,
          // A member carries no index of its own; keys that depend on the index
          // cannot identify it, and such a surface has no stable selection anyway.
          rowKey: (row) => key(row, 0),
        }),
        openKeys: openFolds ?? EMPTY_KEYS,
      });
    }
    return sections;
  }, [
    flat,
    fields,
    groupBy,
    rowKey,
    manualRank,
    aggregate,
    resolveGrouping,
    now,
    groupOrder,
    rowsComplete,
    sectioning,
    fold,
    openFolds,
    selectedRowId,
    matchesKeep,
  ]);
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();
