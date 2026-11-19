import { createContext, use, useMemo, type ReactNode } from "react";
import {
  DataTable,
  DATA_TABLE_VIRTUALIZE_THRESHOLD,
  type ColumnDef,
  type DataTableGroup,
  type DataTableParts,
  type DataTableRowDecoration,
} from "@plugins/primitives/plugins/data-table/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import {
  DataViewGroupHeader,
  FieldCell,
  NestedSectionIndent,
  drawnFields,
  dropOrderOf,
  fieldAlign,
  wearsTimeInk,
  resolveCover,
  SectionBody,
  useDataViewSections,
  useIsChipField,
  useItemActionZones,
  usePlacement,
  useResolveCell,
  useResolveCellEditor,
  useResolveOperatorSet,
  DATA_VIEW_HEADER_OFFSET_VAR,
  type DataViewAggregateConfig,
  type DataViewRenderProps,
  type DataViewSection,
  type FieldDef,
  type FieldValue,
  type ItemActionsDescriptor,
  type ManualOrderConfig,
} from "@plugins/primitives/plugins/data-view/web";
import {
  RankReorderProvider,
  useRankSortableItem,
} from "@plugins/primitives/plugins/rank-reorder/web";
import {
  visibleSections,
  type Slot,
  type ViewSlots,
} from "@plugins/primitives/plugins/data-view/core";
import type { TableViewOptions } from "../../core";
import { mapPrimary } from "../internal/map-primary";
import { tableHeaderOption } from "../internal/column-captions";
import {
  CoverCell,
  StackedTitleCell,
  type StackedTitle,
} from "../internal/title-cell";
import { NestedTableView } from "./nested-table-view";
import {
  useLatestSelector,
  useLatestStore,
  type LatestStore,
} from "@plugins/primitives/plugins/latest-ref/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

/** FieldValue → data-table's `string | number | undefined` comparable projection. */
function coerce(value: FieldValue): string | number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return Number(value);
  if (value === null) return undefined;
  return value;
}

/**
 * The slots a table draws: the lead as the first column (its value whole, a
 * state's glyph and label), the title column with its marks inline and line 2
 * stacked under it, then the trailing columns and the edge column last.
 */
export const TABLE_SLOTS: ViewSlots = {
  lead: { capacity: 1 },
  title: { capacity: 1 },
  afterTitle: {},
  line2: {},
  trail: {},
  edge: { capacity: 1 },
};

/** The leading cover column's id: NUL-prefixed, never a field id. */
const COVER_COLUMN_ID = "\u0000cover";

/** The table's elements, named in data-view's part vocabulary. */
const TABLE_PARTS: DataTableParts = {
  table: "dv.table",
  headerRow: "dv.column-header-row",
  columnHeader: "dv.column-header",
  row: "dv.row",
  cell: "dv.cell",
};

/**
 * The table view. A hierarchical source nests its rows (`NestedTableView`, the
 * hierarchy pipeline over the tree model); any other source is the flat table.
 * Two components, not one with a branch, so each runs only its own hooks.
 */
export function TableView(props: DataViewRenderProps<unknown>): ReactNode {
  return props.hierarchy ? (
    <NestedTableView {...props} />
  ) : (
    <FlatTableView {...props} />
  );
}

function FlatTableView(props: DataViewRenderProps<unknown>): ReactNode {
  // Documented cast boundary: `options` is `viewOptions.table`, opaque to the host.
  const options = (props.options ?? {}) as TableViewOptions;
  // Resolved unconditionally (hooks rules) BEFORE the early empty-state return.
  const resolveCell = useResolveCell();
  const resolveEditor = useResolveCellEditor();
  // Rows arrive RAW; the section pipeline applies flat search/filter/sort and
  // group-by partitioning.
  const resolveOperatorSet = useResolveOperatorSet();
  // Manual order arrives type-erased; present only when the host activated it.
  const manualOrder = props.manualOrder as
    ManualOrderConfig<unknown> | undefined;
  // Cross-section capability: present ⇒ a drop into another section is offered
  // and reported; absent ⇒ the primitive refuses those drops visibly.
  const onReseat = manualOrder?.onReseat;
  // Aggregate arrives type-erased; present only when the consumer supplied it.
  const aggregate = props.aggregate as
    DataViewAggregateConfig<unknown> | undefined;
  // Documented cast boundary: itemActions arrives type-erased.
  const itemActions = props.itemActions as
    ItemActionsDescriptor<unknown> | undefined;
  const isChipField = useIsChipField();
  // Columns are the view's placement (the surface's recipe and pins, the
  // user's Properties). Sort/filter/search run over the FULL `props.fields`.
  const placement = usePlacement(
    props.fields,
    props.state.properties,
    props.placement,
    TABLE_SLOTS,
  );
  // `cover: true` — a leading thumbnail column, when the surface is covered
  // (the cover field it is drawn from is then no column of its own).
  const covers =
    options.cover === true
      ? resolveCover(drawnFields(placement), props.cover)
      : null;
  const thumb = covers?.hasCovers ? covers : null;
  // A table row HAS a permanent per-row region — the reserved trailing track —
  // so persistent-zone actions stay painted at rest there, ahead of the
  // hover-revealed cluster. Resolved before the early empty-state return.
  // A primary slot only over a thumbnail (the action sits on it, on hover);
  // without one a primary action rests in the trailing track like a
  // persistent one.
  const {
    cluster: { atRest: persistent, revealed },
    primary,
  } = useItemActionZones(itemActions, {
    hasPersistentSlot: true,
    hasPrimarySlot: thumb !== null,
  });
  const sections = useDataViewSections(
    props.rows,
    props.fields,
    props.state,
    resolveOperatorSet,
    props.searchAccessor,
    {
      rowKey: props.rowKey,
      manualRank: manualOrder?.getRank,
      aggregate,
      now: props.now,
      groupOrder: props.groupOrder,
      rowsComplete: props.rowsComplete,
      sectioning: props.sectioning,
      openFolds: props.foldLines?.open,
      selectedRowId: props.selectedRowId,
    },
  );

  // What a manual-order row's decoration reads (`useManualOrderDecoration`).
  // DataTable's per-row decoration hook only receives `(row, key)`, but the
  // primitive needs the row's group to scope a drag to its own section — so
  // it is resolved by row key here, once per set of sections, and read per
  // row (a store, not a context value: a search re-partitions the sections,
  // and only the rows whose section changed may re-render).
  const rowKey = props.rowKey;
  const getRank = manualOrder?.getRank;
  const sectionKeyByRowKey = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const section of sections) {
      for (const entry of section.entries) map.set(entry.key, section.key);
    }
    return map;
  }, [sections]);
  const sectionOf =
    useLatestStore<ReadonlyMap<string, string | null>>(sectionKeyByRowKey);
  const manualRowContext = useMemo(
    (): ManualRowContextValue | null =>
      getRank === undefined ? null : { getRank, sectionOf },
    [getRank, sectionOf],
  );
  // Aggregate representatives carry a `×N` badge in the primary cell, keyed
  // by row OBJECT identity (the cell renderer gets the row, not its index) —
  // stable, since the representative row object flows through unchanged.
  // Read per row through a store, so the columns (and every row they reach)
  // do not change when the counts do.
  const aggregateCountByRow = useMemo(() => {
    const map = new Map<unknown, number>();
    for (const section of sections) {
      for (const entry of section.entries) {
        if (entry.aggregateCount && entry.aggregateCount > 1) {
          map.set(entry.row, entry.aggregateCount);
        }
      }
    }
    return map;
  }, [sections]);
  const aggregateCounts =
    useLatestStore<ReadonlyMap<unknown, number>>(aggregateCountByRow);

  // The host owns loading→empty precedence (it skips this view while loading),
  // so an empty section set always means confirmed-empty.
  const totalCount = sections.reduce((sum, s) => sum + s.count.n, 0);
  // DataTable's `emptyLabel` is string-only; render a custom empty node here so
  // the host-provided `emptyState` (ReactNode) is honored.
  // Framed like every other view's empty state (list, gallery, icons): centred,
  // so it needs no inline edge from the body, which opens no region.
  if (totalCount === 0 && props.emptyState !== undefined) {
    return (
      <Center axis="both" className="py-xl">
        <Text as="div" variant="body" className="text-muted-foreground">
          {props.emptyState}
        </Text>
      </Center>
    );
  }

  const drawn = (list: readonly FieldDef<unknown>[]) =>
    thumb?.field ? list.filter((f) => f !== thumb.field) : [...list];
  const { slots } = placement;
  const titleField = drawn(slots.title)[0];
  const afterTitle = drawn(slots.afterTitle);
  const line2 = drawn(slots.line2);
  // The title column stacks its marks and line 2 with it (a card's text in one
  // column) when the placement gives it any.
  const stacked: StackedTitle | null =
    titleField !== undefined && (afterTitle.length > 0 || line2.length > 0)
      ? {
          title: titleField,
          indicators: afterTitle,
          subtitle: line2,
          subtitleIsChip: line2.map((f) => isChipField(f)),
          resolveCell,
          resolveEditor,
        }
      : null;
  const slotOf = new Map<string, Slot>();
  const columnFields: FieldDef<unknown>[] = [];
  for (const slot of ["lead", "title", "trail", "edge"] as const) {
    for (const f of drawn(slots[slot])) {
      slotOf.set(f.id, slot);
      columnFields.push(f);
    }
  }
  // The badge lands on the title column (else the first one drawn).
  const primaryFieldId = titleField?.id ?? columnFields[0]?.id;

  const fieldColumns: ColumnDef<unknown>[] = columnFields.map((f) => ({
    id: f.id,
    // `header: false` ⇒ an unlabelled column (empty header cell); the field
    // keeps its `label` everywhere a field is picked.
    header: f.header === false ? "" : (f.header ?? f.label),
    width: f.width,
    align: fieldAlign(f, placement),
    // What gives way in a narrow table: the trailing columns, least important
    // first, then the edge; the lead and the title never drop.
    dropOrder: dropOrderOf(f, slotOf.get(f.id)!, placement),
    value: f.value ? (row: unknown) => coerce(f.value!(row)) : undefined,
    // The host's sortable set, never `value`'s presence: a field showing a
    // value its list cannot order by (a live source's derived or unsortable
    // column) offers no header sort.
    sortable: props.sortHeader.sortable.has(f.id),
    // A number takes the numeric cell pick (soft), as a card's token does.
    numeric: (row: unknown) => typeof f.value?.(row) === "number",
    cell: (row: unknown) => {
      const cell =
        stacked && f === stacked.title ? (
          <StackedTitleCell spec={stacked} row={row} />
        ) : (
          <FieldCell
            field={f}
            row={row}
            resolveCell={resolveCell}
            resolveEditor={resolveEditor}
          />
        );
      // The edge and every time wear the time ink, as in a list row.
      if (
        f.id !== primaryFieldId &&
        wearsTimeInk(f, slotOf.get(f.id)!, placement)
      ) {
        return <span className="text-list-time-ink">{cell}</span>;
      }
      if (f.id !== primaryFieldId || aggregate === undefined) return cell;
      return (
        <AggregateCount counts={aggregateCounts} row={row}>
          {cell}
        </AggregateCount>
      );
    },
    // The title takes the slack unless its field sets a width.
    ...(f === titleField ? { width: f.width ?? "minmax(0,1fr)" } : undefined),
  }));
  // The props a render calls are read into locals first: `props.x?.(…)` is a
  // method call on `props`, which the compiler can only key on the whole props
  // object — new on every render of the host — so the columns and row
  // actions (and every row they reach) would be rebuilt each time.
  const { hasChildren, setSort, setSectionCollapsed, sectionSummary } = props;
  const hasChildrenOf = (row: unknown): boolean =>
    hasChildren?.(rowKey(row, 0)) ?? false;
  const columns: ColumnDef<unknown>[] = thumb
    ? [
        {
          id: COVER_COLUMN_ID,
          header: "",
          width: "auto",
          sortable: false,
          cell: (row: unknown) => (
            <CoverCell
              content={thumb.coverOf(row)}
              primary={primary}
              row={row}
              hasChildren={hasChildrenOf(row)}
            />
          ),
        },
        ...fieldColumns,
      ]
    : fieldColumns;

  const actionProps = (row: unknown, key: string) => ({
    row,
    hasChildren: hasChildren?.(key) ?? false,
  });
  const rowActions = revealed
    ? (row: unknown, key: string) => revealed(actionProps(row, key))
    : undefined;
  const rowPersistentActions = persistent
    ? (row: unknown, key: string) => persistent(actionProps(row, key))
    : undefined;

  const shared = {
    columns,
    rowKey: props.rowKey,
    // The ACTIVE sort, for the arrow — `state.sort` is empty under a
    // server-ordered source.
    sortState: mapPrimary(props.sortHeader.active),
    onToggleSort: (columnId: string) => setSort(columnId),
    // The table speaks the same `Activation` the surface resolves: a link row's
    // middle- / ⌘-click opens its URL in a browser tab, Enter runs it.
    rowActivation: props.rowActivation,
    onRowOpen: props.onRowOpen,
    selectedRowId: props.selectedRowId,
    filter: undefined,
    emptyLabel: "No results found",
    rowActions,
    rowPersistentActions,
    // Pin the table's own sticky rows (column header + group headers) below the
    // DataView's sticky toolbar, reading the host-published toolbar height. Fixes
    // both the column header (was hiding behind the toolbar) and the group headers
    // (were not sticky) — consistent with the list view's sticky group headers.
    stickyHeaderOffset: `var(${DATA_VIEW_HEADER_OFFSET_VAR}, 0px)`,
    // Opening a fold line folds in the rows it set aside.
    openKeys: props.foldLines?.open,
    // Manual order: per-row drag affordances. Composes with DataTable's
    // windowing. Sort is already hidden by the host while manual order is on.
    ...(manualOrder ? MANUAL_ORDER_DECORATION : undefined),
    columnHeader: options.columnHeader,
    // The view's Column captions switch, else the code's `header`.
    header: tableHeaderOption(options),
    density: props.density,
    // A flat table draws `soft` when asked; `grid` / `outline` flat stay the
    // grid it has always drawn (outline is the nested table's sidebar look).
    presentation:
      options.presentation === "soft" ? ("soft" as const) : undefined,
    parts: TABLE_PARTS,
  };

  // Ungrouped renders as one flat body; grouped interleaves a header row per
  // section. Either windows its rows past DATA_TABLE_VIRTUALIZE_THRESHOLD —
  // grouped, per section.
  const ungrouped = sections.length === 1 && sections[0]!.key === null;

  const renderTable = (activeId: string | null): ReactNode =>
    ungrouped ? (
      <DataTable
        data={sections[0]!.entries.map((e) => e.row)}
        // The fold line is a full-span row after the body (the table composes
        // its own section chrome, so it places the line itself): a body band
        // holding only the fold line, the same rail-paying band the table's
        // group headers sit in.
        footer={
          sections[0]!.fold ? (
            <SectionBody section={sections[0]!} foldLines={props.foldLines}>
              {null}
            </SectionBody>
          ) : undefined
        }
        // Pin the drag source so it stays mounted when the window scrolls past
        // it — otherwise its draggable unregisters mid-gesture and dnd-kit
        // cancels the drop.
        keepMountedRowKeys={activeId ? [activeId] : undefined}
        {...shared}
      />
    ) : (
      // Grouped: interleave a full-width collapsible header row per section.
      <DataTable
        data={[]}
        // A collapsed nested section hides its descendants' group rows too.
        groups={visibleSections(sections, props.collapsedSections).map(
          (section): DataTableGroup<unknown> => {
            const key = section.key!;
            const collapsed = props.collapsedSections?.has(key) ?? false;
            return {
              key,
              collapsed,
              rows: section.entries.map((e) => e.row),
              // Past the stack's cap a nested header pins below its parents.
              parentKey: section.nesting?.parentKey ?? undefined,
              // Hidden with the group's rows when collapsed, like GroupedSections:
              // the fold line, and a declared section's own paging footer.
              footer:
                section.fold || section.paging ? (
                  <SectionBody section={section} foldLines={props.foldLines}>
                    {null}
                  </SectionBody>
                ) : undefined,
              // The same header node the flat views render (GroupedSections),
              // so every group-header style reads identically here.
              // A nested section's header steps in by its depth. The band
              // around it already paid the rail, so no guides (they start at it).
              header: (
                <NestedSectionIndent
                  depth={section.nesting?.depth ?? 0}
                  guides={false}
                >
                  <DataViewGroupHeader
                    section={section}
                    open={!collapsed}
                    onClick={() => setSectionCollapsed?.(key, !collapsed)}
                    summary={sectionSummary?.(section)}
                  />
                </NestedSectionIndent>
              ),
            };
          },
        )}
        {...shared}
      />
    );

  // Manual order: wrap the table in one sortable rank-reorder host spanning
  // every section. In-section drags reorder; a drop into ANOTHER section is a
  // group write plus a reorder, so it is offered only when the config supplies
  // `onReseat` — otherwise the primitive limits the drag to its own section.
  if (manualOrder) {
    // Rows mount/unmount mid-drag only when the body windows; the shell then
    // re-measures droppables every frame so a freshly mounted row (autoscrolled
    // into view) is a valid drop target. `filter` is undefined here, so the
    // table's row count is exactly the section's entry count.
    const windowed = sections.some(
      (section) =>
        !(props.collapsedSections?.has(section.key!) ?? false) &&
        section.entries.length > DATA_TABLE_VIRTUALIZE_THRESHOLD,
    );
    return (
      <RankReorderProvider
        items={manualOrderItems(sections, manualOrder)}
        measuringAlways={windowed}
        onMove={(id, dest) =>
          manualOrder.onMove(id, {
            rank: dest.rank,
            targetId: dest.targetId,
            zone: dest.zone,
          })
        }
        onReseat={
          onReseat
            ? (id, dest) =>
                onReseat(id, {
                  groupKey: dest.group,
                  targetId: dest.targetId,
                  zone: dest.zone,
                })
            : undefined
        }
      >
        {(activeId) => (
          <ManualRowContext value={manualRowContext}>
            {renderTable(activeId)}
          </ManualRowContext>
        )}
      </RankReorderProvider>
    );
  }
  return renderTable(null);
}

/** What a manual-order row's decoration reads, handed down as one context
 *  value so the decoration hook is a module constant: a hook declared inside
 *  the view was a new `useRowDecoration` on every render (re-rendering every
 *  row) and kept the React Compiler off the whole view. */
interface ManualRowContextValue {
  getRank: ManualOrderConfig<unknown>["getRank"];
  /** Which section each row sits in, by row key — read per row. */
  sectionOf: LatestStore<ReadonlyMap<string, string | null>>;
}

const ManualRowContext = createContext<ManualRowContextValue | null>(null);

/**
 * Per-row decoration hook (called once per row inside DataTable's row
 * component, so it may call hooks): the whole row is the sortable drag source,
 * following the pointer while dragged and sliding while another row of its
 * section passes. Passed to DataTable only in manual mode.
 */
function useManualOrderDecoration(
  row: unknown,
  id: string,
): DataTableRowDecoration | undefined {
  const ctx = use(ManualRowContext);
  if (ctx === null)
    throw new Error("A manual-order table row rendered outside its table view");
  const rank = ctx.getRank(row);
  const section = useLatestSelector(ctx.sectionOf, (m) => m.get(id) ?? null);
  // Destructured so render never reads a member off the hook output
  // (react-hooks/refs flags member access on it, not destructuring).
  const { ref, listeners, style } = useRankSortableItem(id, rank, section);
  // A null rank marks the row non-orderable: the hook still runs (hooks rule),
  // but we return no decoration so its ref attaches to nothing — the row is
  // neither a drag source nor a drop target.
  if (rank == null) return undefined;
  return { ref, props: { ...listeners }, style };
}

/** The manual-order decoration, bound once so the view hands `DataTable` a
 *  constant (and never names a hook as a value, which the compiler refuses). */
const MANUAL_ORDER_DECORATION = { useRowDecoration: useManualOrderDecoration };

/** A primary cell with its aggregate's `×N` badge, when the row represents
 *  several — read per row, so a change of the counts redraws only the rows
 *  whose count changed. */
function AggregateCount({
  counts,
  row,
  children,
}: {
  counts: LatestStore<ReadonlyMap<unknown, number>>;
  row: unknown;
  children: ReactNode;
}): ReactNode {
  const count = useLatestSelector(counts, (m) => m.get(row));
  if (!count) return children;
  return (
    <Inline gap="xs">
      {children}
      <Badge variant="muted">{`×${count}`}</Badge>
    </Inline>
  );
}

/** Flatten the sections into the rank-reorder item list (id + rank + group).
 *  Null-rank entries are non-orderable, so they are neither reorder-scope
 *  members nor drop targets — filter them out before mapping. */
function manualOrderItems(
  sections: DataViewSection<unknown>[],
  manualOrder: ManualOrderConfig<unknown>,
) {
  return sections.flatMap((section) =>
    section.entries.flatMap((entry) => {
      const rank = manualOrder.getRank(entry.row);
      return rank != null ? [{ id: entry.key, rank, group: section.key }] : [];
    }),
  );
}
