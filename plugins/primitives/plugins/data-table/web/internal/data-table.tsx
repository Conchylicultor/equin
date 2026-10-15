import { Icon } from "@plugins/ui/plugins/icons/web";
import { Fragment, useMemo, type CSSProperties, type ReactNode } from "react";
import {
  cn,
  ControlSizeProvider,
  SingleLineProvider,
  useSidewaysScroll,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  RowActions,
  rowActionsAnchor,
} from "@plugins/primitives/plugins/row-actions/web";
import { useVirtualRows } from "@plugins/primitives/plugins/virtual-rows/web";
import {
  useRowFold,
  type RowFoldProps,
} from "@plugins/primitives/plugins/virtual-rows/plugins/row-fold/web";
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
import { NESTED_LEAD_MIN_PX, useColumnFit } from "./use-column-fit";
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
/** An outline's header: the muted caption over tree rows, a tree row tall,
 *  its rule under it. */
const OUTLINE_HEADER_CLASS =
  "min-h-tree-row text-caption-compact font-medium text-faint-foreground";

const arrowDownwardIcon = symbol("arrow-downward");
const arrowUpwardIcon = symbol("arrow-upward");
const unfoldMoreIcon = symbol("unfold-more");

/** A decoration without `provide`: the row's content as is. */
const identity = (content: ReactNode): ReactNode => content;

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
function composeRefs<E extends Element>(
  a: ((el: E | null) => void) | undefined,
  b: ((el: E | null) => void) | undefined,
): ((el: E | null) => void) | undefined {
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
  { base: string; hover: string; selected: string }
> = {
  // The grid row paints its tint through `--dt-row-tint` rather than a `bg-*`
  // class, so the sticky first cell — which must be opaque to cover the
  // columns scrolling under it — paints the SAME tint over the surface.
  grid: {
    base: "col-span-full grid grid-cols-subgrid items-center border-b border-border/30 text-caption [background-color:var(--dt-row-tint)]",
    hover:
      "hover:[--dt-row-tint:color-mix(in_oklab,var(--accent)_30%,transparent)]",
    selected: "[--dt-row-tint:var(--accent)]",
  },
  // The hover tint applies only to a row that is not selected, so a selected
  // row does not hover to a different tone.
  outline: {
    base: "col-span-full grid grid-cols-subgrid items-center rounded-md min-h-tree-row text-body",
    hover: "hover:bg-accent hover:[--scrim:var(--accent)]",
    selected:
      "bg-selected text-selected-foreground [--scrim:var(--selected)] [--row-meta:var(--selected-meta-foreground)]",
  },
};
/** A decoration's `highlighted` row (a drop target): the accent tint. */
const ROW_HIGHLIGHT: Record<DataTablePresentation, string> = {
  grid: "[--dt-row-tint:var(--accent)]",
  outline: "bg-accent [--scrim:var(--accent)]",
};

/** The inline inset every subgrid row takes (`rail-follow`'s start side). */
const RAIL_START =
  "var(--rail-owed-start, var(--rail-start, var(--chrome-pad-x)))";
const RAIL_END = "var(--rail-owed-end, var(--rail-end, var(--chrome-pad-x)))";
/**
 * An outline row is the tree row's pill ON the rail: the rail is its margin
 * (the pill starts where a `rail-follow` band's content does), and the pill
 * pads its own content by the tree row's inset — so its label sits where a
 * `TreeRowChrome` row's does.
 */
const OUTLINE_INSET: CSSProperties = {
  marginInline: `${RAIL_START} ${RAIL_END}`,
  paddingInline: "var(--space-xs)",
};
/** A nested outline row: its tree head pays the lead inset itself (the tree
 *  row's `--tree-row-pad-start`, inside its indent), so the pill pads only its
 *  trailing edge. */
const OUTLINE_INSET_NESTED: CSSProperties = {
  ...OUTLINE_INSET,
  paddingInline: "0 var(--space-xs)",
};
/**
 * The sticky first cell reaches over its row's rail inset on the left and over
 * the column gap on the right (negative margin, paid back as padding), so
 * nothing scrolling under it shows on either side while it is pinned, and its
 * content still sits on the rail.
 */
const LEAD_EDGE: CSSProperties = {
  marginLeft: `calc(-1 * ${RAIL_START})`,
  paddingLeft: RAIL_START,
  marginRight: "calc(-1 * var(--space-sm))",
  paddingRight: "var(--space-sm)",
};
/** A body row's sticky first cell: opaque — the surface, under the row's own
 *  tint — so it matches the row at rest, hovered, selected or highlighted. */
const LEAD_CELL: CSSProperties = {
  ...LEAD_EDGE,
  backgroundColor: "var(--chrome-mask)",
  backgroundImage:
    "linear-gradient(var(--dt-row-tint, transparent), var(--dt-row-tint, transparent))",
};
/** A wide table's header label: never wraps. */
const NOWRAP: CSSProperties = { whiteSpace: "nowrap" };

/**
 * A full-span band's content, pinned to the visible part of a wide table: at
 * most as wide as the scroller shows. The scroller is an inline-size container
 * exactly while the table overflows it (see `Scroll`), so `100cqi` is the
 * visible width then — and the viewport, which caps nothing, otherwise.
 */
const SPAN_PIN: CSSProperties = { maxWidth: "100cqi" };

/**
 * Nested, the first column holds the tree head (indent, guides, disclosure)
 * before the name, so it keeps the tree's label floor: past that the table
 * scrolls sideways rather than squeezing the names away.
 */
const NESTED_LEAD_EDGE: CSSProperties = {
  ...LEAD_EDGE,
  minWidth: NESTED_LEAD_MIN_PX,
};
const NESTED_LEAD_CELL: CSSProperties = {
  ...LEAD_CELL,
  minWidth: NESTED_LEAD_MIN_PX,
};

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
  openKeys: hostOpenKeys,
  controlSize = "xs",
  stickyHeaderOffset = "0px",
  columnHeader = "row",
  density = "comfortable",
  presentation = "grid",
  header,
  tree,
  selection,
}: DataTableProps<TRow>) {
  // A grid table in a region that may scroll it sideways (`wide`: a pane's
  // `Scroll`, no card / popover / clipping box in between — see
  // `useColumnFit`) scrolls when its columns do not fit — after the ones that
  // may drop have — with its first column pinned. An outline (a sidebar), or a
  // table in a card or a popover, keeps squeezing into its box: no pinned
  // column, nothing dropped.
  const sideways = useSidewaysScroll();
  // An outline's revealed cluster overlays its row's trailing edge (the tree
  // row's), so it reserves no track: a sidebar's labels keep the width a hidden
  // cluster would take. A persistent cluster is painted at rest and needs room.
  const hasActionsTrack =
    !!rowPersistentActions || (!!rowActions && presentation === "grid");
  // Destructured: render never reads a member off the hook output (the refs
  // rule flags member access on a value carrying refs).
  const {
    wide: pinLead,
    shown: shownColumns,
    tracks: columnTracks,
    containerRef: fitContainerRef,
    gridRef: fitGridRef,
  } = useColumnFit(columns, {
    // A grid table in a sideways-scroll region goes wide; an outline with its
    // labels drops columns in its box; anything else squeezes.
    mode:
      presentation === "grid"
        ? sideways
          ? "wide"
          : "none"
        : header
          ? "drop"
          : "none",
    nested: !!tree,
    hasActionsTrack,
  });
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

  // The body as one flat list of lines — each group's header, rows and footer
  // in paint order — so a group's collapse (or a host disclosure: a nested
  // row's toggle, a fold line) folds through the one row-fold mechanism.
  const lines = useMemo(
    () => bodyLines(groups, rows, rowKey),
    [groups, rows, rowKey],
  );
  const openKeys = useMemo(() => {
    if (!groups) return hostOpenKeys;
    const open = new Set(hostOpenKeys);
    for (const group of groups)
      if (!group.collapsed) open.add(groupLineKey(group));
    return open;
  }, [groups, hostOpenKeys]);
  // Stand-ins for rows not listed yet: a group's footer (its paging / fold
  // line, drawn before a live section's rows arrive) and a nested row's lazy
  // placeholder. Rows landing in their place fold in.
  const fullSpan = tree?.fullSpan;
  const fold = useRowFold({
    items: lines,
    getKey: lineKeyOf,
    openKeys,
    isStandIn: (line) =>
      line.kind === "footer" ||
      (line.kind === "row" && fullSpan?.(line.row) != null),
  });

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
  // both clusters share, so it is reserved whenever either is present
  // (`hasActionsTrack`, above).
  // Every subgrid row (column header, data row) takes the SAME block padding,
  // picked once here from the table's density.
  const rowPad = density === "compact" ? "py-row-compact" : "py-row";

  // `first-group`: the column labels ride the first group's header instead of a
  // header row. Its label spans the leading tracks up to the first labelled
  // column — so it needs at least one unlabelled leading track, and a group to
  // ride. Otherwise it falls back to the header row (see DataTableColumnHeader).
  const firstLabelled = shownColumns.findIndex((col) => !!col.header);
  const leadSpan = firstLabelled === -1 ? shownColumns.length : firstLabelled;
  // An outline has no column labels at all — neither a header row nor labels
  // on the first group.
  const showHeader = header ?? presentation === "grid";
  const outlineHeader = showHeader && presentation === "outline";
  const labelsOnFirstGroup =
    showHeader &&
    !outlineHeader &&
    columnHeader === "first-group" &&
    !!groups &&
    groups.length > 0 &&
    leadSpan > 0;

  const headerCells = (cellClassName?: string) =>
    shownColumns.map((col, c) => {
      const sortable = col.sortable ?? !!col.value;
      const active = sortState?.columnId === col.id;
      // The fit measures a content-sized column's minimum on its label,
      // which never wraps — so the label is also the narrowest an `auto` track
      // gets. An inline box, so its width is the label's.
      // An outline's header shows the arrow on the sorted column only.
      const label = (
        <span data-column-id={col.id}>
          {col.header}
          {sortable && (active || !outlineHeader) && (
            <SortIcon
              active={active}
              direction={active ? sortState!.direction : null}
            />
          )}
        </span>
      );
      const lead =
        c === 0 && outlineHeader && tree?.headerLeading
          ? tree.headerLeading(label)
          : label;
      const cellProps = {
        className: cn(
          cellClassName,
          alignClass(col.align),
          sortable && "cursor-pointer select-none",
        ),
        onClick: sortable ? () => toggleSort(col.id) : undefined,
      };
      // The first column's label pins with the cells below it — the cell
      // itself, so it stays the click target that sorts. A plain span like
      // the `Text` beside it (no variant: the header row's typography).
      return c === 0 && pinLead ? (
        <Sticky
          key={col.id}
          as="span"
          edge="left"
          layer="base"
          mask
          {...cellProps}
          style={{ ...(tree ? NESTED_LEAD_EDGE : LEAD_EDGE), ...NOWRAP }}
        >
          {label}
        </Sticky>
      ) : (
        // Wide, a label never wraps (it is the track's floor); squeezed, it
        // wraps as it always did.
        <Text
          as="span"
          key={col.id}
          {...cellProps}
          style={pinLead ? NOWRAP : undefined}
        >
          {lead}
        </Text>
      );
    });

  // The first group's header in `first-group` mode: the caller's header node in
  // a cell across the leading tracks, then the remaining columns' label cells in
  // their own tracks (and the actions track's empty span). renderGroupHeader
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
    // A grid table floors a flexible column at its label (`floorAtLabel`), so
    // overflowing scrolls it rather than collapsing the column to nothing.
    ...columnTracks,
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
    foldProps: RowFoldProps,
    measure?: RowMeasure,
  ) => {
    // A tree's full-span line (a lazy placeholder) is no row: no decoration
    // hook, no cells, no actions — one band across every track.
    const span = tree?.fullSpan?.(row);
    if (span != null) {
      return (
        <div
          key={rowKey(row, i)}
          ref={measure?.ref}
          {...foldProps}
          data-index={measure?.index}
          // eslint-disable-next-line layout/no-adhoc-layout -- full-span line spanning the subgrid table's column tracks (a tree's placeholder child)
          className="col-span-full rail-follow"
        >
          <PinToView active={pinLead}>{span}</PinToView>
        </div>
      );
    }
    return (
      <DataTableRow
        key={rowKey(row, i)}
        row={row}
        index={i}
        columns={shownColumns}
        rowKey={rowKey}
        selectedRowId={selectedRowId}
        rowActivation={rowActivation}
        onRowOpen={onRowOpen}
        rowActions={rowActions}
        rowPersistentActions={rowPersistentActions}
        useRowDecoration={useDecorate}
        measure={measure}
        foldProps={foldProps}
        rowPad={rowPad}
        presentation={presentation}
        tree={tree}
        selectable={!!selection}
        pinLead={pinLead}
        metaColumns={outlineHeader}
      />
    );
  };

  // One body line, whichever body draws it — the fold's row props on its
  // outermost element, which is a direct child of the grid.
  const renderLine = (line: BodyLine<TRow>, measure?: RowMeasure) => {
    const foldProps = fold.rowProps(line.key);
    switch (line.kind) {
      case "row":
        return renderRow(line.row, line.index, foldProps, measure);
      case "header":
        return renderGroupHeader(
          line,
          line.first ? firstGroupLabels : undefined,
          foldProps,
          pinLead,
        );
      case "footer":
        return (
          <div
            key={line.key}
            {...foldProps}
            // eslint-disable-next-line layout/no-adhoc-layout -- full-span group-footer row spanning the subgrid table's column tracks
            className="col-span-full"
          >
            <PinToView active={pinLead}>{line.group.footer}</PinToView>
          </div>
        );
    }
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
      {/* The table's box: what the fit measures the room in, and what it
          marks `data-scrolls-x` while the grid is wider (useColumnFit). */}
      <div ref={fitContainerRef}>
        <div
          // eslint-disable-next-line layout/no-adhoc-layout -- subgrid table host: a dynamic gridTemplateColumns grid whose rows are full-span subgrids (no Frame/Grid equivalent)
          className="grid gap-x-sm"
          style={{
            gridTemplateColumns: template,
            // A grid table never squeezes a column below its track's minimum
            // (a content-sized one: its label); past that it overflows.
            minWidth: pinLead ? "min-content" : undefined,
          }}
          // Nesting rows make the grid a treegrid, and the grid the keyboard
          // host: a key on a focused row walks the painted lines.
          role={tree ? "treegrid" : undefined}
          ref={composeRefs<HTMLElement>(tree?.containerRef, fitGridRef)}
          // The fold's host: its direct children are the body's lines.
          {...fold.hostProps}
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
              data-slot="data-table-header"
              // eslint-disable-next-line layout/no-adhoc-layout -- sticky header is itself a full-span subgrid row inheriting the host's column tracks
              className={cn(
                "col-span-full grid grid-cols-subgrid border-b",
                // Every subgrid row — this header, each data row, each group header —
                // takes its inline padding from the ambient rail and its block padding
                // from the row density token. Column alignment holds because they all
                // read the SAME rail, which is what made the old fixed padding work.
                // An outline's header takes its rows' inset instead (the pill
                // on the rail), so its labels sit over theirs.
                outlineHeader
                  ? [OUTLINE_HEADER_CLASS, "items-center"]
                  : [HEADER_TEXT_CLASS, rowPad, "rail-follow"],
              )}
              style={{
                top: stickyHeaderOffset,
                ...(outlineHeader
                  ? {
                      ...(tree ? OUTLINE_INSET_NESTED : OUTLINE_INSET),
                      // A breath under the rule before the first row.
                      marginBottom: "var(--space-xs)",
                    }
                  : undefined),
              }}
            >
              {headerCells()}
              {hasActionsTrack && <span aria-hidden />}
            </Sticky>
          )}
          {groups ? (
            // Group headers accumulate: with few enough groups every header
            // stays pinned, each below the last (StickyStack sums their measured
            // heights); past the stack's cap it degrades to the swap hand-off,
            // where each arriving header covers the pinned one. `base` is the
            // column header's own pinned bottom edge, so the first group header
            // pins flush beneath it.
            //
            // All group headers share the one grid as their sticky containing
            // block (the subgrid table can't wrap a group in its own block
            // without breaking column alignment), which is exactly what the
            // stack needs — and StickyStack renders no element of its own, so
            // the `col-span-full` lines stay direct grid children: the tracks
            // line up, and the fold finds them.
            <StickyStack
              keys={groups.map((group) => group.key)}
              base={groupHeaderTop}
            >
              {fold.items.map((line) => renderLine(line))}
            </StickyStack>
          ) : rows.length > VIRTUALIZE_THRESHOLD ? (
            <VirtualTableBody
              lines={fold.items}
              selectedRowId={selectedRowId}
              renderLine={renderLine}
              keepMounted={keepMountedRowKeys}
              drawPastEnd={fold.inFlight}
            />
          ) : (
            fold.items.map((line) => renderLine(line))
          )}
          {!groups && footer != null ? (
            // A rule under the rows: it slides with them as they fold.
            <div
              {...fold.rowProps(FOOTER_LINE_KEY)}
              // eslint-disable-next-line layout/no-adhoc-layout -- full-span footer row spanning the subgrid table's column tracks
              className="col-span-full"
            >
              <PinToView active={pinLead}>{footer}</PinToView>
            </div>
          ) : null}
        </div>
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
  foldProps,
  rowPad,
  presentation,
  tree,
  selectable,
  pinLead,
  metaColumns,
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
  measure?: RowMeasure;
  /** The row's place in a fold (`useRowFold`). */
  foldProps: RowFoldProps;
  /** The row block-padding class, from the table's density. */
  rowPad: "py-row" | "py-row-compact";
  presentation: DataTablePresentation;
  tree: DataTableTree<TRow> | undefined;
  /** Draw the multi-select checkbox ahead of the first cell. */
  selectable: boolean;
  /** Pin the first cell to the scroller's left edge (grid presentation). */
  pinLead: boolean;
  /** Draw every column after the first as meta (a labelled outline). */
  metaColumns: boolean;
}): ReactNode {
  const decoration = useRowDecoration(row, index);
  // A row whose activation is a link reads the link gestures: ⌘/middle-click
  // open its href in a browser tab instead of opening it here.
  const activation = rowActivation?.(row);
  const gestures = activationProps(activation);
  const key = rowKey(row, index);
  // Destructure-and-rename so render never does inline `decoration.ref` member
  // access on the hook output (react-hooks/refs flags member access on a ref
  // value in render; destructuring is fine).
  const decorationRef = decoration?.ref;
  const decorationProps = decoration?.props;
  const decorationClassName = decoration?.className;
  const decorationStyle = decoration?.style;
  const decorationOverlay = decoration?.overlay;
  const decorationHighlighted = decoration?.highlighted;
  const decorationProvide = decoration?.provide;
  // The revealed cluster's content: the decoration's, when it states one.
  const revealedActions =
    decoration && "actions" in decoration
      ? decoration.actions
      : rowActions?.(row, index);
  const outline = presentation === "outline";
  // A decorated row in a windowed body is BOTH a drag source and a measurement
  // target, so the two refs compose (they were mutually exclusive back when
  // decoration disabled virtualization).
  const rowRef = composeRefs<HTMLElement>(decorationRef, measure?.ref);
  const look = ROW_LOOK[presentation];
  const selected = key === selectedRowId;
  return (
    <div
      ref={rowRef}
      {...foldProps}
      data-index={measure?.index}
      // The row's identity on the DOM — the same marker the list and icons
      // views carry — so a test can address one row instead of walking text.
      data-row-key={key}
      // eslint-disable-next-line layout/no-adhoc-layout -- CSS subgrid row inheriting the outer grid's column tracks (no Frame/Grid equivalent for subgrid)
      className={cn(
        look.base,
        !selected && look.hover,
        // Same rail as the column header and the group headers — see there.
        // An outline row is the tree row's pill instead: its block padding
        // is the tree row's, its rail a margin (`OUTLINE_INSET`).
        outline ? "py-xs" : [rowPad, "rail-follow"],
        // Reveals the trailing RowActions cluster; its bundled `relative` also
        // hosts the decoration overlay (a positioned row with `z-index: auto`
        // lays out and stacks identically, so it is inert on plain rows).
        rowActionsAnchor,
        selected && look.selected,
        decorationHighlighted && ROW_HIGHLIGHT[presentation],
        (rowActivation || onRowOpen) && "cursor-pointer",
        decorationClassName,
      )}
      style={
        outline
          ? {
              ...(tree ? OUTLINE_INSET_NESTED : OUTLINE_INSET),
              ...(tree?.pillIndent
                ? {
                    marginLeft: `calc(${RAIL_START} + ${tree.pillIndent(row)})`,
                  }
                : undefined),
              ...decorationStyle,
            }
          : decorationStyle
      }
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
      {(decorationProvide ?? identity)(
        <>
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
                  meta={metaColumns && c > 0}
                >
                  {col.cell
                    ? col.cell(row)
                    : col.value
                      ? String(col.value(row) ?? "")
                      : null}
                </AlignedCell>
              );
              if (c > 0) return cell;
              // The first cell carries the row's head: the checkbox ahead of it,
              // and — when the rows nest — the tree head around both.
              const head = selectable ? (
                <Stack
                  key={col.id}
                  direction="row"
                  gap="xs"
                  align="center"
                  // A flex item of the tree head: it must shrink with the
                  // track so the cell inside truncates instead of spilling
                  // over the next column.
                  // eslint-disable-next-line layout/no-adhoc-layout -- shrinkable box around the checkbox and the truncating first cell
                  className="min-w-0"
                >
                  <SelectionToggle id={key} />
                  {cell}
                </Stack>
              ) : (
                cell
              );
              const lead = tree ? tree.leading(row, head) : head;
              return pinLead ? (
                <Sticky
                  key={col.id}
                  as="div"
                  edge="left"
                  layer="base"
                  // eslint-disable-next-line layout/no-adhoc-layout -- the pinned first grid cell must shrink to its track so its label truncates
                  className="min-w-0"
                  style={tree ? NESTED_LEAD_CELL : LEAD_CELL}
                >
                  {lead}
                </Sticky>
              ) : (
                <Fragment key={col.id}>{lead}</Fragment>
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
          {outline && revealedActions != null ? (
            // An outline's revealed cluster overlays the row's trailing edge, as
            // a tree row's does (pinned, masked by the row's tint) — no track.
            // A row with no actions mounts no cluster at all.
            <RowActions>{revealedActions}</RowActions>
          ) : null}
          <CompactActionsCell compact={rowPad === "py-row-compact"}>
            {rowPersistentActions ? (
              <Stack direction="row" gap="none" align="center" justify="end">
                <RowActions pin={null} alwaysVisible>
                  {rowPersistentActions(row, index)}
                </RowActions>
                {rowActions && !outline ? (
                  <RowActions pin={null}>{revealedActions}</RowActions>
                ) : null}
              </Stack>
            ) : rowActions && !outline ? (
              // eslint-disable-next-line layout/no-adhoc-layout -- placement class for the reserved actions track; RowActions owns everything else about the cluster
              <RowActions pin={null} className="justify-end">
                {revealedActions}
              </RowActions>
            ) : null}
          </CompactActionsCell>
          {decorationOverlay}
        </>,
      )}
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
  lines,
  selectedRowId,
  renderLine,
  keepMounted,
  drawPastEnd,
}: {
  lines: readonly BodyLine<TRow>[];
  selectedRowId: string | undefined;
  renderLine: (line: BodyLine<TRow>, measure: RowMeasure) => ReactNode;
  keepMounted: readonly string[] | undefined;
  /** Rows the fold in flight moves (`useRowFold().inFlight`). */
  drawPastEnd: number;
}) {
  // Reveal the selected row when selection changes off-screen.
  const selectedIndex = selectedRowId
    ? lines.findIndex((line) => line.key === selectedRowId)
    : -1;

  const {
    measureRef,
    virtualizer,
    virtualItems,
    totalSize,
    scrollMargin,
    probe,
  } = useVirtualRows<BodyLine<TRow>>({
    items: lines,
    estimateSize: ROW_ESTIMATE,
    getKey: lineKeyOf,
    scrollToIndex: selectedIndex >= 0 ? selectedIndex : null,
    keepMounted,
    drawPastEnd: Math.min(drawPastEnd, MAX_DRAW_PAST_END),
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
        {probe !== null && lines.length > 0
          ? renderLine(lines[0]!, { ref: probe, index: 0 })
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
            {renderLine(lines[vi.index]!, {
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
 * A group's full-span header line. In `first-group` mode (`labels`) the FIRST
 * group's band becomes a subgrid row carrying the column labels; otherwise
 * every header is a full-span band.
 */
function renderGroupHeader<TRow>(
  line: Extract<BodyLine<TRow>, { kind: "header" }>,
  labels: FirstGroupLabels | undefined,
  foldProps: RowFoldProps,
  /** Pin the band to the visible part of a sideways-scrolling table. */
  pinLead: boolean,
): ReactNode {
  const { group } = line;
  return labels ? (
    <StickyStackItem
      key={line.key}
      {...foldProps}
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
      key={line.key}
      {...foldProps}
      itemKey={group.key}
      as="div"
      mask
      layer="raised"
      // eslint-disable-next-line layout/no-adhoc-layout -- full-span sticky group-header row spanning the subgrid table's column tracks
      className="col-span-full rail-follow"
      // Pinned on the left too, as wide as the table's box: a sideways
      // scroll leaves the label (and its count) in view.
      style={pinLead ? GROUP_BAND_PIN : undefined}
    >
      {group.header}
    </StickyStackItem>
  );
}

/** A windowed row's measurement handle (tanstack's `measureElement` reads the
 *  `data-index`). */
interface RowMeasure {
  ref: (el: Element | null) => void;
  index: number;
}

/**
 * One line of the table body, in paint order: a data row, or — grouped — a
 * group's header and footer around its rows. A collapsed group draws its
 * header alone.
 */
type BodyLine<TRow> =
  | { kind: "row"; key: string; row: TRow; index: number }
  | {
      kind: "header";
      key: string;
      group: DataTableGroup<TRow>;
      /** The first group's header, the one `first-group` labels ride. */
      first: boolean;
    }
  | { kind: "footer"; key: string; group: DataTableGroup<TRow> };

function lineKeyOf<TRow>(line: BodyLine<TRow>): string {
  return line.key;
}

/** A group header's line key — also the group's key in the fold's open set,
 *  so a group's collapse is a flip of a line both lists draw. NUL-prefixed:
 *  never a row key. */
function groupLineKey<TRow>(group: DataTableGroup<TRow>): string {
  return `\u0000group:${group.key}`;
}

/** The ungrouped body's footer — a fold row too, so it slides with the rows. */
const FOOTER_LINE_KEY = "\u0000footer";

/** How far past its window a fold in flight draws (rows) — see `VirtualRows`. */
const MAX_DRAW_PAST_END = 60;

/**
 * The body's lines. The row index is global across groups, so `rowKey(row, i)`
 * stays stable and unique.
 */
function bodyLines<TRow>(
  groups: DataTableGroup<TRow>[] | undefined,
  rows: readonly TRow[],
  rowKey: (row: TRow, index: number) => string,
): BodyLine<TRow>[] {
  if (!groups) {
    return rows.map((row, index) => ({
      kind: "row",
      key: rowKey(row, index),
      row,
      index,
    }));
  }
  const out: BodyLine<TRow>[] = [];
  let index = 0;
  groups.forEach((group, g) => {
    out.push({
      kind: "header",
      key: groupLineKey(group),
      group,
      first: g === 0,
    });
    if (group.collapsed) return;
    for (const row of group.rows) {
      out.push({ kind: "row", key: rowKey(row, index), row, index });
      index++;
    }
    if (group.footer != null)
      out.push({ kind: "footer", key: `\u0000footer:${group.key}`, group });
  });
  return out;
}

/** A group band pinned to the left edge, as wide as the scroller shows. */
const GROUP_BAND_PIN: CSSProperties = { left: 0, ...SPAN_PIN };

/**
 * A full-span band's content, pinned to the scroller's left edge, as wide as
 * the scroller shows — so a fold line or a placeholder stays readable however
 * far a wide table has scrolled. Inactive, the content as it was.
 */
function PinToView({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}): ReactNode {
  if (!active) return children;
  return (
    <Sticky as="div" edge="left" layer="base" style={SPAN_PIN}>
      {children}
    </Sticky>
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
  meta = false,
  children,
}: {
  align: ColumnDef<unknown>["align"];
  /** `gridcell` inside a treegrid; absent in a flat table. */
  role?: "gridcell";
  /** A secondary column of a labelled outline: the row's meta caption
   *  (muted, or the selected row's meta colour), as the tree's aligned
   *  columns wore. */
  meta?: boolean;
  children: ReactNode;
}) {
  const cell = (
    <Text
      as="div"
      role={role}
      className={cn(alignClass(align), meta && "text-caption text-row-meta")}
    >
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
