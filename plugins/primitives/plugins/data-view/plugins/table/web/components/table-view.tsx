import type { ReactNode } from "react";
import {
  DataTable,
  DATA_TABLE_VIRTUALIZE_THRESHOLD,
  type ColumnDef,
  type DataTableGroup,
  type DataTableRowDecoration,
} from "@plugins/primitives/plugins/data-table/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import {
  DataViewGroupHeader,
  FieldCell,
  pickPrimaryField,
  resolveBodyFields,
  SectionBody,
  useDataViewSections,
  useItemActionZones,
  useResolveCell,
  useResolveCellEditor,
  useResolveOperatorSet,
  DATA_VIEW_HEADER_OFFSET_VAR,
  type DataViewAggregateConfig,
  type DataViewRenderProps,
  type DataViewSection,
  type FieldValue,
  type ItemActionsDescriptor,
  type ManualOrderConfig,
} from "@plugins/primitives/plugins/data-view/web";
import {
  RankReorderProvider,
  useRankSortableItem,
} from "@plugins/primitives/plugins/rank-reorder/web";
import type { TableViewOptions } from "../../core";
import { mapPrimary } from "../internal/map-primary";
import { NestedTableView } from "./nested-table-view";

/** FieldValue → data-table's `string | number | undefined` comparable projection. */
function coerce(value: FieldValue): string | number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return Number(value);
  if (value === null) return undefined;
  return value;
}

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
  // A table row HAS a permanent per-row region — the reserved trailing track —
  // so persistent-zone actions stay painted at rest there, ahead of the
  // hover-revealed cluster. Resolved before the early empty-state return.
  const { persistent, revealed } = useItemActionZones(itemActions, {
    hasPersistentSlot: true,
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

  // Which section each row sits in. DataTable's per-row decoration hook only
  // receives `(row, index)`, but the primitive needs the row's group to scope a
  // drag to its own section — so resolve it by row key here, once.
  const sectionKeyByRowKey = new Map<string, string | null>();
  for (const section of sections) {
    for (const entry of section.entries) {
      sectionKeyByRowKey.set(entry.key, section.key);
    }
  }

  // Per-row decoration hook (called once per row inside DataTable's row
  // component, so it may call hooks): the whole row is the sortable drag source,
  // following the pointer while dragged and sliding while another row of its
  // section passes. Defined unconditionally (recognized as a hook by name);
  // passed to DataTable only in manual mode.
  function useRowDecoration(
    row: unknown,
    i: number,
  ): DataTableRowDecoration | undefined {
    const id = props.rowKey(row, i);
    const rank = manualOrder!.getRank(row);
    // Destructured so render never reads a member off the hook output
    // (react-hooks/refs flags member access on it, not destructuring).
    const { ref, listeners, style } = useRankSortableItem(
      id,
      rank,
      sectionKeyByRowKey.get(id) ?? null,
    );
    // A null rank marks the row non-orderable: the hook still runs (hooks rule),
    // but we return no decoration so its ref attaches to nothing — the row is
    // neither a drag source nor a drop target.
    if (rank == null) return undefined;
    return { ref, props: { ...listeners }, style };
  }

  // The host owns loading→empty precedence (it skips this view while loading),
  // so an empty section set always means confirmed-empty.
  const totalCount = sections.reduce((sum, s) => sum + s.count.n, 0);
  // DataTable's `emptyLabel` is string-only; render a custom empty node here so
  // the host-provided `emptyState` (ReactNode) is honored.
  if (totalCount === 0 && props.emptyState !== undefined) {
    return <>{props.emptyState}</>;
  }

  // Body columns follow the view's Properties (visible-fields) policy: which
  // fields and in what order. `null` → identity (`props.fields`), so a view with
  // no Properties configured renders every column unchanged. Sort/filter/search
  // above still run over the FULL `props.fields`.
  const vis = resolveBodyFields(props.fields, props.state.properties);
  // Aggregate representatives carry a `×N` badge in the primary cell. Key the
  // count by row OBJECT identity (the cell renderer gets the row, not its index),
  // which is stable since the representative row object flows through unchanged.
  const aggregateCountByRow = new Map<unknown, number>();
  for (const section of sections) {
    for (const entry of section.entries) {
      if (entry.aggregateCount && entry.aggregateCount > 1) {
        aggregateCountByRow.set(entry.row, entry.aggregateCount);
      }
    }
  }
  // Primary picked over the VISIBLE subset so the badge lands on a rendered
  // column (matches the list/gallery `pickPrimaryField(vis)` semantics).
  const primaryFieldId = pickPrimaryField(vis)?.id ?? vis[0]?.id;

  const columns: ColumnDef<unknown>[] = vis.map((f) => ({
    id: f.id,
    // `header: false` ⇒ an unlabelled column (empty header cell); the field
    // keeps its `label` everywhere a field is picked.
    header: f.header === false ? "" : (f.header ?? f.label),
    width: f.width,
    align: f.align,
    dropOrder: f.dropOrder,
    value: f.value ? (row: unknown) => coerce(f.value!(row)) : undefined,
    // The host's sortable set, never `value`'s presence: a field showing a
    // value its list cannot order by (a live source's derived or unsortable
    // column) offers no header sort.
    sortable: props.sortHeader.sortable.has(f.id),
    cell: (row: unknown) => {
      const cell = (
        <FieldCell
          field={f}
          row={row}
          resolveCell={resolveCell}
          resolveEditor={resolveEditor}
        />
      );
      const count =
        f.id === primaryFieldId ? aggregateCountByRow.get(row) : undefined;
      if (!count) return cell;
      return (
        <Inline gap="xs">
          {cell}
          <Badge variant="muted">{`×${count}`}</Badge>
        </Inline>
      );
    },
  }));

  const actionProps = (row: unknown, i: number) => ({
    row,
    hasChildren: props.hasChildren?.(props.rowKey(row, i)) ?? false,
  });
  const rowActions = revealed
    ? (row: unknown, i: number) => revealed(actionProps(row, i))
    : undefined;
  const rowPersistentActions = persistent
    ? (row: unknown, i: number) => persistent(actionProps(row, i))
    : undefined;

  const shared = {
    columns,
    rowKey: props.rowKey,
    // The ACTIVE sort, for the arrow — `state.sort` is empty under a
    // server-ordered source.
    sortState: mapPrimary(props.sortHeader.active),
    onToggleSort: (columnId: string) => props.setSort(columnId),
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
    useRowDecoration: manualOrder ? useRowDecoration : undefined,
    columnHeader: options.columnHeader,
    density: props.density,
  };

  // Ungrouped renders as one flat body (the only body DataTable windows);
  // grouped interleaves a header row per section and never windows.
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
        groups={sections.map((section): DataTableGroup<unknown> => {
          const key = section.key!;
          const collapsed = props.collapsedSections?.has(key) ?? false;
          return {
            key,
            collapsed,
            rows: section.entries.map((e) => e.row),
            // Hidden with the group's rows when collapsed, like GroupedSections:
            // the fold line, and a declared section's own paging footer.
            footer:
              section.fold || section.paging ? (
                <SectionBody section={section} foldLines={props.foldLines}>
                  {null}
                </SectionBody>
              ) : undefined,
            // The same header node the flat views render (GroupedSections),
            // so `groupHeaders` reads identically here.
            header: (
              <DataViewGroupHeader
                section={section}
                headerStyle={props.groupHeaders}
                open={!collapsed}
                onClick={() => props.setSectionCollapsed?.(key, !collapsed)}
              />
            ),
          };
        })}
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
    const windowed =
      ungrouped &&
      sections[0]!.entries.length > DATA_TABLE_VIRTUALIZE_THRESHOLD;
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
        {(activeId) => renderTable(activeId)}
      </RankReorderProvider>
    );
  }
  return renderTable(null);
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
