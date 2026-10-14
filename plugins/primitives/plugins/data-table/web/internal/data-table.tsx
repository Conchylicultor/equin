import { Icon } from "@plugins/ui/plugins/icons/web";
import { Fragment, type ReactNode } from "react";
import {
  cn,
  ControlSizeProvider,
  SingleLineProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  RowActions,
  rowActionsAnchor,
} from "@plugins/primitives/plugins/row-actions/web";
import { useVirtualRows } from "@plugins/primitives/plugins/virtual-rows/web";
import {
  Sticky,
  stickyOffsetPx,
} from "@plugins/primitives/plugins/css/plugins/sticky/web";
import {
  StickyStack,
  StickyStackItem,
} from "@plugins/primitives/plugins/css/plugins/sticky/plugins/stack/web";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  MultiSelectProvider,
  SelectionBar,
  SelectionCheckbox,
} from "@plugins/primitives/plugins/multi-select/web";
import type {
  ColumnDef,
  DataTableGroup,
  DataTablePresentation,
  DataTableProps,
  DataTableRowDecoration,
  DataTableSelection,
  DataTableTree,
} from "./types";
import { useDataTable } from "./use-data-table";
import {
  runActivation,
  type Activation,
} from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

/** The column-label text style — on the header row as a whole in `"row"` mode,
 *  on each label cell when the labels ride the first group's header. */
const HEADER_TEXT_CLASS =
  "text-3xs font-medium uppercase tracking-wider text-muted-foreground";

const arrowDownwardIcon = symbol("arrow-downward");
const arrowUpwardIcon = symbol("arrow-upward");
const unfoldMoreIcon = symbol("unfold-more");

/** No-op decoration hook so `DataTableRow` always calls a hook unconditionally
 *  (rules-of-hooks), whether or not the consumer supplied `useRowDecoration`. */
const useNoRowDecoration = (): DataTableRowDecoration | undefined => undefined;

/** Above this row count the table windows its rows via the shared virtualizer
 *  (keeps the subgrid + sticky header; only the visible slice is in the DOM).
 *  Smaller tables keep the plain map — no virtualizer overhead. Exported because
 *  a drag-reordering consumer must know whether the body windows to decide
 *  whether its `RankReorderProvider` needs `measuringAlways`. */
export const VIRTUALIZE_THRESHOLD = 100;

/**
 * Compose two callback refs into one. A row can be a drag source (decoration
 * ref) AND a virtualizer measurement target (measure ref) at the same time, and
 * a DOM node takes one `ref`. The repo has no `mergeRefs`/`composeRefs` helper
 * today; lift this into a primitive if a second caller needs it.
 */
function composeRefs(
  a: ((el: HTMLElement | null) => void) | undefined,
  b: ((el: Element | null) => void) | undefined,
): ((el: HTMLDivElement | null) => void) | undefined {
  if (!a) return b;
  if (!b) return a;
  return (el) => {
    a(el);
    b(el);
  };
}

/** The windowed body's first guess, px per row — replaced before paint by a
 *  probed real row, then by the first row measured (`useVirtualRows`). */
const ROW_ESTIMATE = 36;

/**
 * A row's look per presentation. `grid` is the table's own (a hairline under
 * every row, a faint hover tint, an accent fill when selected); `outline` is the
 * tree row's pill, on the tree row's tokens. Each tint co-publishes itself as
 * `--scrim` (the colour a pinned action cluster's mask paints), and the selected
 * pill publishes `--row-meta` for its secondary text — the `Row` contract.
 */
const ROW_LOOK: Record<
  DataTablePresentation,
  { base: string; selected: string }
> = {
  grid: {
    base: "col-span-full grid grid-cols-subgrid items-center border-b border-border/30 text-caption hover:bg-accent/30",
    selected: "bg-accent",
  },
  outline: {
    base: "col-span-full grid grid-cols-subgrid items-center rounded-md text-caption",
    selected:
      "bg-selected text-selected-foreground [--scrim:var(--selected)] [--row-meta:var(--selected-meta-foreground)]",
  },
};
/** The outline pill's hover tint — only on a row that is not selected, so a
 *  selected row does not hover to a different tone. */
const OUTLINE_HOVER = "hover:bg-accent hover:[--scrim:var(--accent)]";

/** The selection checkbox's hover reveal: `SelectionCheckbox` reveals on a BARE
 *  `group-hover`, and a table row's named group is the row-actions anchor. */
const CHECKBOX_REVEAL =
  "group-hover/row-actions:opacity-100 group-hover/row-actions:pointer-events-auto";

export function DataTable<TRow>({
  data,
  columns,
  groups,
  filter,
  footer,
  rowKey,
  emptyLabel = "No results found",
  sortState: controlledSort,
  onToggleSort,
  rowActivation,
  onRowOpen,
  rowActions,
  rowPersistentActions,
  selectedRowId,
  useRowDecoration,
  keepMountedRowKeys,
  controlSize = "xs",
  stickyHeaderOffset = "0px",
  columnHeader = "row",
  density = "comfortable",
  presentation = "grid",
  tree,
  selection,
}: DataTableProps<TRow>) {
  const { rows, sortState, toggleSort } = useDataTable(
    data,
    columns,
    filter,
    controlledSort,
    onToggleSort,
    // A tree's lines arrive in paint order; reordering them would tear
    // children from their parents.
    !!tree,
  );

  // Measure the sticky column-header row so group headers can stack directly
  // below it: their sticky `top` is `stickyHeaderOffset + this height`. Synchronous
  // initial measure (element-size) → correct on first paint, before any scroll.
  const [headerRef, { height: headerHeight }] = useElementSize();

  // In grouped mode the body rows come from each group (pre-sorted by the host
  // pipeline), not `data`; count them for the empty check.
  const bodyRowCount = groups
    ? groups.reduce((n, g) => n + g.rows.length, 0)
    : rows.length;

  const hasFooter = groups
    ? groups.some((g) => g.footer != null)
    : footer != null;

  // The rows a checkbox can select, in paint order — the multi-select range
  // order. A collapsed group paints none; a full-span line is no row.
  const selectableKeys = selection
    ? (groups
        ? groups.flatMap((g) =>
            g.collapsed ? [] : g.rows.map((row) => ({ row })),
          )
        : rows.map((row) => ({ row }))
      ).flatMap(({ row }, i) =>
        tree?.fullSpan?.(row) != null ? [] : [rowKey(row, i)],
      )
    : [];

  if (bodyRowCount === 0 && !hasFooter) {
    return (
      <ControlSizeProvider size={controlSize}>
        <Center axis="both" className="h-32">
          <Text as="div" variant="caption" className="text-muted-foreground">
            {emptyLabel}
          </Text>
        </Center>
      </ControlSizeProvider>
    );
  }

  // One grid owns the column tracks; the header and every row are full-span
  // subgrids that inherit those exact tracks (and the column gap), so columns
  // align structurally — independent of content. Dynamic template → inline style.
  // A trailing `auto` track holds the per-row actions column — the ONE track
  // both clusters share, so it is reserved whenever either is present.
  const hasActionsTrack = !!rowActions || !!rowPersistentActions;
  // Every subgrid row (column header, data row) takes the SAME block padding,
  // picked once here from the table's density.
  const rowPad = density === "compact" ? "py-row-compact" : "py-row";

  // `first-group`: the column labels ride the first group's header instead of a
  // header row. Its label spans the leading tracks up to the first labelled
  // column — so it needs at least one unlabelled leading track, and a group to
  // ride. Otherwise it falls back to the header row (see DataTableColumnHeader).
  const firstLabelled = columns.findIndex((col) => !!col.header);
  const leadSpan = firstLabelled === -1 ? columns.length : firstLabelled;
  // An outline has no column labels at all — neither a header row nor labels
  // on the first group.
  const showHeader = presentation === "grid";
  const labelsOnFirstGroup =
    showHeader &&
    columnHeader === "first-group" &&
    !!groups &&
    groups.length > 0 &&
    leadSpan > 0;

  const headerCells = (cellClassName?: string) =>
    columns.map((col) => {
      const sortable = col.sortable ?? !!col.value;
      const active = sortState?.columnId === col.id;
      return (
        <Text
          as="span"
          key={col.id}
          className={cn(
            cellClassName,
            alignClass(col.align),
            sortable && "cursor-pointer select-none",
          )}
          onClick={sortable ? () => toggleSort(col.id) : undefined}
        >
          {col.header}
          {sortable && (
            <SortIcon
              active={active}
              direction={active ? sortState!.direction : null}
            />
          )}
        </Text>
      );
    });

  // The first group's header in `first-group` mode: the caller's header node in
  // a cell across the leading tracks, then the remaining columns' label cells in
  // their own tracks (and the actions track's empty span). renderGroupedBody
  // makes that group's sticky band the subgrid row these cells sit in.
  const firstGroupLabels: FirstGroupLabels | undefined = labelsOnFirstGroup
    ? {
        leadSpan,
        cells: (
          <>
            {headerCells(HEADER_TEXT_CLASS).slice(leadSpan)}
            {hasActionsTrack && <span aria-hidden />}
          </>
        ),
      }
    : undefined;
  const template = [
    ...columns.map((col) => col.width ?? "auto"),
    ...(hasActionsTrack ? ["auto"] : []),
  ].join(" ");

  // Shared row renderer so the plain branch and the windowed branch render
  // identical rows. The optional `measure` handle is supplied only by the
  // virtualized branch (tanstack's measureElement reads the data-index). Routed
  // through `DataTableRow` (a component) so per-row decoration may call hooks.
  const useDecorate = useRowDecoration ?? useNoRowDecoration;
  const renderRow = (
    row: TRow,
    i: number,
    measure?: { ref: (el: Element | null) => void; index: number },
  ) => {
    // A tree's full-span line (a lazy placeholder) is no row: no decoration
    // hook, no cells, no actions — one band across every track.
    const span = tree?.fullSpan?.(row);
    if (span != null) {
      return (
        <div
          key={rowKey(row, i)}
          ref={measure?.ref}
          data-index={measure?.index}
          // eslint-disable-next-line layout/no-adhoc-layout -- full-span line spanning the subgrid table's column tracks (a tree's placeholder child)
          className="col-span-full rail-follow"
        >
          {span}
        </div>
      );
    }
    return (
      <DataTableRow
        key={rowKey(row, i)}
        row={row}
        index={i}
        columns={columns}
        rowKey={rowKey}
        selectedRowId={selectedRowId}
        rowActivation={rowActivation}
        onRowOpen={onRowOpen}
        rowActions={rowActions}
        rowPersistentActions={rowPersistentActions}
        useRowDecoration={useDecorate}
        measure={measure}
        rowPad={rowPad}
        presentation={presentation}
        tree={tree}
        selectable={!!selection}
      />
    );
  };

  // Group headers pin flush beneath the sticky column header (which itself pins
  // at `stickyHeaderOffset`, below any consumer chrome such as a DataView toolbar).
  // Without a header row (labels on the first group) they pin at the offset.
  const groupHeaderTop =
    labelsOnFirstGroup || !showHeader
      ? stickyHeaderOffset
      : `calc(${stickyHeaderOffset} + ${stickyOffsetPx(headerHeight)}px)`;

  const table = (
    <ControlSizeProvider size={controlSize}>
      <div
        // eslint-disable-next-line layout/no-adhoc-layout -- subgrid table host: a dynamic gridTemplateColumns grid whose rows are full-span subgrids (no Frame/Grid equivalent)
        className="grid gap-x-sm"
        style={{ gridTemplateColumns: template }}
        // Nesting rows make the grid a treegrid, and the grid the keyboard
        // host: a key on a focused row walks the painted lines.
        role={tree ? "treegrid" : undefined}
        ref={tree?.containerRef}
        onKeyDown={tree?.onKeyDown}
      >
        {/* The column-header row pins to the scroll viewport at `stickyHeaderOffset`
          (0 by default; a DataView passes its toolbar height so the header stacks
          BELOW the toolbar instead of hiding behind it). `mask` follows the
          embedding surface so rows never show through the pinned bar. */}
        {labelsOnFirstGroup || !showHeader ? null : (
          <Sticky
            as="div"
            ref={headerRef}
            edge="top"
            mask
            layer="raised"
            // eslint-disable-next-line layout/no-adhoc-layout -- sticky header is itself a full-span subgrid row inheriting the host's column tracks
            className={cn(
              "col-span-full grid grid-cols-subgrid border-b",
              HEADER_TEXT_CLASS,
              // Every subgrid row — this header, each data row, each group header —
              // takes its inline padding from the ambient rail and its block padding
              // from the row density token. Column alignment holds because they all
              // read the SAME rail, which is what made the old fixed padding work.
              rowPad,
              "rail-follow",
            )}
            style={{ top: stickyHeaderOffset }}
          >
            {headerCells()}
            {hasActionsTrack && <span aria-hidden />}
          </Sticky>
        )}
        {groups ? (
          renderGroupedBody(groups, renderRow, groupHeaderTop, firstGroupLabels)
        ) : rows.length > VIRTUALIZE_THRESHOLD ? (
          <VirtualTableBody
            rows={rows}
            rowKey={rowKey}
            selectedRowId={selectedRowId}
            renderRow={renderRow}
            keepMounted={keepMountedRowKeys}
          />
        ) : (
          rows.map((row, i) => renderRow(row, i))
        )}
        {!groups && footer != null ? (
          // eslint-disable-next-line layout/no-adhoc-layout -- full-span footer row spanning the subgrid table's column tracks
          <div className="col-span-full">{footer}</div>
        ) : null}
      </div>
    </ControlSizeProvider>
  );
  return selection ? (
    <WithSelection selection={selection} orderedIds={selectableKeys}>
      {table}
    </WithSelection>
  ) : (
    table
  );
}

/** The multi-select provider over the table's rows, with its bar above them. */
function WithSelection({
  selection,
  orderedIds,
  children,
}: {
  selection: DataTableSelection;
  orderedIds: readonly string[];
  children: ReactNode;
}): ReactNode {
  return (
    <MultiSelectProvider orderedIds={orderedIds}>
      <SelectionBar actions={selection.actions} />
      {children}
    </MultiSelectProvider>
  );
}

/**
 * One table row. A component (not an inline closure) so `useRowDecoration` may be
 * called as a hook per row (e.g. `useRankSortableItem` for drag reorder). The
 * decoration adds a drag-source ref, spreads drag props, extra classes, inline
 * style (the sortable slide), and an in-row overlay. Markup is byte-for-byte the
 * legacy row when no decoration is returned.
 */
function DataTableRow<TRow>({
  row,
  index,
  columns,
  rowKey,
  selectedRowId,
  rowActivation,
  onRowOpen,
  rowActions,
  rowPersistentActions,
  useRowDecoration,
  measure,
  rowPad,
  presentation,
  tree,
  selectable,
}: {
  row: TRow;
  index: number;
  columns: ColumnDef<TRow>[];
  rowKey: (row: TRow, index: number) => string;
  selectedRowId: string | undefined;
  rowActivation: ((row: TRow) => Activation | undefined) | undefined;
  onRowOpen: ((row: TRow) => void) | undefined;
  rowActions: ((row: TRow, index: number) => ReactNode) | undefined;
  rowPersistentActions: ((row: TRow, index: number) => ReactNode) | undefined;
  useRowDecoration: Hook<
    (row: TRow, index: number) => DataTableRowDecoration | undefined
  >;
  measure?: { ref: (el: Element | null) => void; index: number };
  /** The row block-padding class, from the table's density. */
  rowPad: "py-row" | "py-row-compact";
  presentation: DataTablePresentation;
  tree: DataTableTree<TRow> | undefined;
  /** Draw the multi-select checkbox ahead of the first cell. */
  selectable: boolean;
}): ReactNode {
  const decoration = useRowDecoration(row, index);
  // A row whose activation is a link reads the link gestures: ⌘/middle-click
  // open its href in a browser tab instead of opening it here.
  const activation = rowActivation?.(row);
  const gestures = activationProps(activation);
  const key = rowKey(row, index);
  // Destructure-and-rename so render never does inline `decoration.ref` member
  // access on the hook output (react-hooks/refs flags member access on a ref
  // value in render; destructuring is fine — mirrors the tree's RowChrome).
  const decorationRef = decoration?.ref;
  const decorationProps = decoration?.props;
  const decorationClassName = decoration?.className;
  const decorationStyle = decoration?.style;
  const decorationOverlay = decoration?.overlay;
  // A decorated row in a windowed body is BOTH a drag source and a measurement
  // target, so the two refs compose (they were mutually exclusive back when
  // decoration disabled virtualization).
  const rowRef = composeRefs(decorationRef, measure?.ref);
  const look = ROW_LOOK[presentation];
  const selected = key === selectedRowId;
  return (
    <div
      ref={rowRef}
      data-index={measure?.index}
      // The row's identity on the DOM — the same marker the list and icons
      // views carry — so a test can address one row instead of walking text.
      data-row-key={key}
      // eslint-disable-next-line layout/no-adhoc-layout -- CSS subgrid row inheriting the outer grid's column tracks (no Frame/Grid equivalent for subgrid)
      className={cn(
        look.base,
        presentation === "outline" && !selected && OUTLINE_HOVER,
        // Same rail as the column header and the group headers — see there.
        rowPad,
        "rail-follow",
        // Reveals the trailing RowActions cluster; its bundled `relative` also
        // hosts the decoration overlay (a positioned row with `z-index: auto`
        // lays out and stacks identically, so it is inert on plain rows).
        rowActionsAnchor,
        selected && look.selected,
        (rowActivation || onRowOpen) && "cursor-pointer",
        decorationClassName,
      )}
      style={decorationStyle}
      onClick={
        gestures.onClick
          ? (e) => {
              // The second click of a double-click belongs to `onRowOpen`.
              if (onRowOpen && e.detail > 1) return;
              gestures.onClick?.(e);
            }
          : undefined
      }
      onAuxClick={gestures.onAuxClick}
      onMouseDown={gestures.onMouseDown}
      onDoubleClick={onRowOpen ? () => onRowOpen(row) : undefined}
      role={rowActivation || onRowOpen ? "button" : undefined}
      tabIndex={rowActivation || onRowOpen ? 0 : undefined}
      onKeyDown={
        rowActivation || onRowOpen
          ? (e) => {
              // Only the row's own Enter opens — never one bubbling out of a
              // control inside a cell.
              if (
                e.key === "Enter" &&
                onRowOpen &&
                e.target === e.currentTarget
              ) {
                e.preventDefault();
                onRowOpen(row);
              } else if (
                (e.key === "Enter" || e.key === " ") &&
                activation !== undefined
              ) {
                e.preventDefault();
                runActivation(activation);
              }
            }
          : undefined
      }
      {...decorationProps}
    >
      {/* A cell is a `<Text as="div">`, so wrapping the row's cells in a
          SingleLine context makes each one pick up Text's sanctioned
          `block w-fit max-w-full min-w-0 truncate` leaf recipe (the single home
          of `min-w-0`). As a grid item the cell is blockified and content-sized
          either way, and that `min-w-0` lets it shrink to its track — so a `minmax(0,1fr)` column with a long
          value ellipsizes instead of bleeding over its neighbors (the behavior
          `ColumnDef.width` documents), while `alignClass` still positions the
          content. Scoped to the cells only — the trailing rowActions cluster
          keeps its own flow layout. */}
      <SingleLineProvider value={true}>
        {columns.map((col, c) => {
          const cell = (
            <AlignedCell
              key={col.id}
              align={col.align}
              role={tree ? "gridcell" : undefined}
            >
              {col.cell
                ? col.cell(row)
                : col.value
                  ? String(col.value(row) ?? "")
                  : null}
            </AlignedCell>
          );
          if (c > 0 || (!tree && !selectable)) return cell;
          // The first cell carries the row's head: the checkbox ahead of it,
          // and — when the rows nest — the tree head around both.
          const head = selectable ? (
            <Stack key={col.id} direction="row" gap="xs" align="center">
              <SelectionToggle id={key} />
              {cell}
            </Stack>
          ) : (
            cell
          );
          return tree ? (
            <Fragment key={col.id}>{tree.leading(row, head)}</Fragment>
          ) : (
            head
          );
        })}
      </SingleLineProvider>
      {/* `pin={null}`: the cluster stays IN FLOW, in the reserved trailing
          `auto` track. A table column is genuine flow — an overlaying cluster
          would cover the last column's data — and the track is content-sized,
          so the anchor is stable without pinning. The track is as wide as the
          widest row's action set, hence the right-alignment.

          Both clusters share that ONE track, so when a persistent cluster
          exists the two sit side by side inside a single flow child (persistent
          first, hover-revealed at the trailing edge). They cannot be two direct
          children: a subgrid row has no implicit tracks, so the second would be
          clamped into the last track and paint on top of the first. */}
      <CompactActionsCell compact={rowPad === "py-row-compact"}>
        {rowPersistentActions ? (
          <Stack direction="row" gap="none" align="center" justify="end">
            <RowActions pin={null} alwaysVisible>
              {rowPersistentActions(row, index)}
            </RowActions>
            {rowActions ? (
              <RowActions pin={null}>{rowActions(row, index)}</RowActions>
            ) : null}
          </Stack>
        ) : rowActions ? (
          // eslint-disable-next-line layout/no-adhoc-layout -- placement class for the reserved actions track; RowActions owns everything else about the cluster
          <RowActions pin={null} className="justify-end">
            {rowActions(row, index)}
          </RowActions>
        ) : null}
      </CompactActionsCell>
      {decorationOverlay}
    </div>
  );
}

/**
 * A row's multi-select checkbox. Its own press never reaches the row: a click
 * would activate the row, a pointer-down start its drag.
 */
function SelectionToggle({ id }: { id: string }): ReactNode {
  return (
    <Center
      as="span"
      axis="both"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <SelectionCheckbox id={id} className={CHECKBOX_REVEAL} />
    </Center>
  );
}

/**
 * The trailing actions track's cell. In a compact table the cluster must not
 * set the row's height: an icon button is taller than a compact row's text
 * line, so a row that carries an action would stand taller than one that does
 * not. The compact cell is zero-height and centres its content, so the buttons
 * overflow the row symmetrically instead of growing it.
 */
function CompactActionsCell({
  compact,
  children,
}: {
  compact: boolean;
  children: ReactNode;
}): ReactNode {
  if (!compact || children == null) return children;
  return (
    // eslint-disable-next-line layout/no-adhoc-layout -- zero-height centring box so the actions cluster overflows a compact row instead of growing it
    <div className="flex h-0 items-center justify-end">{children}</div>
  );
}

/**
 * Windowed table body: renders only the visible slice of rows in normal grid
 * flow, with `col-span-full` spacers reserving the off-screen height — so the
 * outer subgrid column tracks and the sticky header stay intact (unlike the
 * absolute/translateY layout `VirtualRows` uses, which would drop rows out of
 * grid flow). A separate component so the virtualizer hook never runs for small
 * tables.
 *
 * `keepMounted` pins a row (an in-flight drag source) into the rendered range,
 * which makes `virtualItems` a NON-contiguous index sequence. So there is one
 * spacer per *gap*, not just a leading and a trailing one. With nothing pinned
 * the range is contiguous, every interior gap is 0, and the emitted DOM is
 * identical to the two-spacer form this generalizes.
 */
function VirtualTableBody<TRow>({
  rows,
  rowKey,
  selectedRowId,
  renderRow,
  keepMounted,
}: {
  rows: readonly TRow[];
  rowKey: (row: TRow, index: number) => string;
  selectedRowId: string | undefined;
  renderRow: (
    row: TRow,
    i: number,
    measure?: { ref: (el: Element | null) => void; index: number },
  ) => ReactNode;
  keepMounted: readonly string[] | undefined;
}) {
  // Reveal the selected row when selection changes off-screen.
  const selectedIndex = selectedRowId
    ? rows.findIndex((row, i) => rowKey(row, i) === selectedRowId)
    : -1;

  const {
    measureRef,
    virtualizer,
    virtualItems,
    totalSize,
    scrollMargin,
    probe,
  } = useVirtualRows<TRow>({
    items: rows,
    estimateSize: ROW_ESTIMATE,
    getKey: rowKey,
    scrollToIndex: selectedIndex >= 0 ? selectedIndex : null,
    keepMounted,
  });

  // The marker sits at the start of the row region (right after the sticky
  // header); scrollMargin is measured from it.
  const marker = (
    // eslint-disable-next-line layout/no-adhoc-layout -- full-span spacer in the subgrid table that reserves the off-screen windowed height
    <div ref={measureRef} aria-hidden className="col-span-full h-0" />
  );

  if (virtualItems.length === 0) {
    return (
      <>
        {marker}
        {/* The first commit draws no window: one real row, measured before
            paint to become the window's estimate (never painted — the
            window replaces it in the same frame). */}
        {probe !== null && rows.length > 0
          ? renderRow(rows[0]!, 0, { ref: probe, index: 0 })
          : null}
        <div
          aria-hidden
          // eslint-disable-next-line layout/no-adhoc-layout -- full-span spacer reserving the windowed table's total height
          className="col-span-full"
          style={{ height: totalSize }}
        />
      </>
    );
  }

  // Leading spacer: the rows above the first rendered one. `scrollMargin` is the
  // region's offset inside the scroller, which the virtualizer folds into every
  // `start`/`end` — so it is subtracted here (and at the trailing spacer), but
  // cancels in an interior gap, where both endpoints carry it.
  const paddingTop = virtualItems[0]!.start - scrollMargin;
  const paddingBottom =
    totalSize - (virtualItems[virtualItems.length - 1]!.end - scrollMargin);

  return (
    <>
      {marker}
      {paddingTop > 0 && (
        <div
          aria-hidden
          // eslint-disable-next-line layout/no-adhoc-layout -- full-span spacer reserving the off-screen rows above the window
          className="col-span-full"
          style={{ height: paddingTop }}
        />
      )}
      {virtualItems.map((vi, i) => {
        // Interior gap: nonzero only where the range skips indexes — i.e. between
        // a pinned row and the window. Contiguous items satisfy `start === prev.end`.
        const prev = i > 0 ? virtualItems[i - 1]! : null;
        const gap = prev ? vi.start - prev.end : 0;
        return (
          <Fragment key={vi.key}>
            {gap > 0 && (
              <div
                aria-hidden
                // eslint-disable-next-line layout/no-adhoc-layout -- full-span spacer reserving the rows skipped between a pinned row and the window
                className="col-span-full"
                style={{ height: gap }}
              />
            )}
            {renderRow(rows[vi.index]!, vi.index, {
              ref: virtualizer.measureElement,
              index: vi.index,
            })}
          </Fragment>
        );
      })}
      {paddingBottom > 0 && (
        <div
          aria-hidden
          // eslint-disable-next-line layout/no-adhoc-layout -- full-span spacer reserving the off-screen rows below the window
          className="col-span-full"
          style={{ height: paddingBottom }}
        />
      )}
    </>
  );
}

/** The column labels the first group's header carries in `first-group` mode. */
interface FirstGroupLabels {
  /** How many leading tracks the group's own header node spans. */
  leadSpan: number;
  /** The label cells for the remaining tracks (actions track included). */
  cells: ReactNode;
}

/**
 * Grouped (non-virtualized) body: a caller-built full-span header per group,
 * then the group's rows when not collapsed — all inside the single subgrid so
 * columns stay aligned across groups. The row index counter is global so
 * `rowKey(row, i)` stays stable/unique across groups.
 */
function renderGroupedBody<TRow>(
  groups: DataTableGroup<TRow>[],
  renderRow: (row: TRow, i: number) => ReactNode,
  groupHeaderTop: string,
  /** `first-group` mode: the FIRST group's band becomes a subgrid row carrying
   *  the column labels. Absent ⇒ every header is a full-span band. */
  firstGroupLabels?: FirstGroupLabels,
): ReactNode {
  let i = 0;
  // Group headers accumulate: with few enough groups every header stays pinned,
  // each below the last (StickyStack sums their measured heights); past the
  // stack's cap it degrades to the swap hand-off, where each arriving header
  // covers the pinned one. `base` is the column header's own pinned bottom edge,
  // so the first group header pins flush beneath it.
  //
  // All group headers already share the one grid as their sticky containing block
  // (the subgrid table can't wrap a group in its own block without breaking column
  // alignment), which is exactly what the stack needs — and StickyStack renders no
  // element of its own, so the `col-span-full` headers stay direct grid children
  // and the tracks still line up. `mask` keeps rows from showing through.
  return (
    <StickyStack keys={groups.map((group) => group.key)} base={groupHeaderTop}>
      {groups.map((group, groupIndex) => {
        const labels = groupIndex === 0 ? firstGroupLabels : undefined;
        return (
          <Fragment key={group.key}>
            {labels ? (
              <StickyStackItem
                itemKey={group.key}
                as="div"
                mask
                layer="raised"
                data-slot="data-table-first-group-header"
                // The band IS a subgrid row here (like a data row, same rail), so
                // the label cells below land in the body's own column tracks.
                // eslint-disable-next-line layout/no-adhoc-layout -- first group header is a full-span subgrid row inheriting the host's column tracks
                className="col-span-full grid grid-cols-subgrid items-center rail-follow"
              >
                <div
                  // eslint-disable-next-line layout/no-adhoc-layout -- the group label's cell spans the unlabelled leading tracks of the subgrid
                  className="min-w-0"
                  style={{ gridColumn: `span ${labels.leadSpan}` }}
                >
                  {group.header}
                </div>
                {labels.cells}
              </StickyStackItem>
            ) : (
              <StickyStackItem
                itemKey={group.key}
                as="div"
                mask
                layer="raised"
                // eslint-disable-next-line layout/no-adhoc-layout -- full-span sticky group-header row spanning the subgrid table's column tracks
                className="col-span-full rail-follow"
              >
                {group.header}
              </StickyStackItem>
            )}
            {group.collapsed
              ? null
              : group.rows.map((row) => renderRow(row, i++))}
            {!group.collapsed && group.footer != null ? (
              // eslint-disable-next-line layout/no-adhoc-layout -- full-span group-footer row spanning the subgrid table's column tracks
              <div className="col-span-full">{group.footer}</div>
            ) : null}
          </Fragment>
        );
      })}
    </StickyStack>
  );
}

function alignClass(align: ColumnDef<unknown>["align"]): string | undefined {
  return align === "end"
    ? "text-right"
    : align === "center"
      ? "text-center"
      : undefined;
}

/**
 * A body cell placed per its column's `align`. The cell is a content-sized
 * (`w-fit`) truncation leaf, so `text-*` alone aligns text inside a box that
 * hugs it and never moves the box: an aligned cell sits in a full-track row
 * that justifies it. A start-aligned cell needs none.
 */
function AlignedCell({
  align,
  role,
  children,
}: {
  align: ColumnDef<unknown>["align"];
  /** `gridcell` inside a treegrid; absent in a flat table. */
  role?: "gridcell";
  children: ReactNode;
}) {
  const cell = (
    <Text as="div" role={role} className={alignClass(align)}>
      {children}
    </Text>
  );
  if (align !== "end" && align !== "center") return cell;
  return (
    <Stack direction="row" gap="none" align="center" justify={align}>
      {cell}
    </Stack>
  );
}

function SortIcon({
  active,
  direction,
}: {
  active: boolean;
  direction: "asc" | "desc" | null;
}) {
  const icon =
    direction === "asc"
      ? arrowUpwardIcon
      : direction === "desc"
        ? arrowDownwardIcon
        : unfoldMoreIcon;
  return (
    <Icon
      icon={icon}
      // eslint-disable-next-line spacing/no-adhoc-spacing -- one-off inline sort-icon offset next to the column header text
      className={cn(
        "mb-px ml-0.5 inline-block size-3 align-middle",
        active ? "text-foreground" : "text-muted-foreground/40",
      )}
    />
  );
}
