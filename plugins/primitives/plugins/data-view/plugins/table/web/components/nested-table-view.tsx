import { useCallback, useMemo, type ReactNode } from "react";
import {
  DataTable,
  DATA_TABLE_VIRTUALIZE_THRESHOLD,
  type ColumnDef,
  type DataTableGroup,
  type DataTableRowDecoration,
  type DataTableTree,
} from "@plugins/primitives/plugins/data-table/web";
import {
  DataViewGroupHeader,
  EditableTreeLabel,
  FieldCell,
  leadingSlot,
  pickLeadingField,
  pickPrimaryField,
  readFallback,
  resolveBodyFields,
  rowToneClass,
  useHierarchyTree,
  useItemActionZones,
  useResolveCell,
  useResolveCellEditor,
  DATA_VIEW_HEADER_OFFSET_VAR,
  type DataViewRenderProps,
  type FieldDef,
  type ItemActionsDescriptor,
  type ProjectedRow,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  FlatTreeLine,
  RowMenuHelpers,
} from "@plugins/primitives/plugins/tree/core";
import {
  groupFoldAction,
  treeRowTrailing,
  RowControlsProvider,
  TreeChildPlaceholder,
  TreeDropZones,
  TreeLeading,
  TreeProvider,
  TreeRootAdd,
  TreeRowActions,
  TreeToolbar,
  useFlatExpandAll,
  treeRowGestures,
  treeRowIndentStyle,
  useTreeKeyboard,
  useTreeContext,
  useTreeModel,
  useTreeRow,
} from "@plugins/primitives/plugins/tree/web";
import { RankReorderDndContext } from "@plugins/primitives/plugins/rank-reorder/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { TableViewOptions } from "../../core";
import { mapPrimary } from "../internal/map-primary";

const linkIcon = symbol("link");

/** The widest a row's `trailing` gets before it clips (see its use). */
const TRAILING_CAP = { maxWidth: "12rem" } as const;

type Row = ProjectedRow<unknown>;
/** One painted line of the nested table: a row, or a lazy placeholder child. */
type Line = FlatTreeLine<Row>;
type NodeLine = Extract<Line, { kind: "node" }>;

/** A line's key: a row's is its node id (the DataView row key, or an alias's
 *  projection id); a placeholder's is derived from its parent's, NUL-prefixed
 *  so it can never be a row key. */
function lineKey(line: Line): string {
  return line.kind === "node"
    ? line.node.id
    : `\u0000placeholder:${line.parent.id}`;
}

/** The node a line belongs to: its own, or the open parent a placeholder
 *  stands under. */
function lineOwner(line: Line): Row {
  return line.kind === "node" ? line.node : line.parent;
}

/**
 * The first cell's tree head: the indent (the tree row's own split between
 * pill and content, so the guides sit where they sit in the tree), the guides,
 * the disclosure (the contributed `Tree.Disclosure` variant when the row has an
 * icon), then the cell. A reference (alias) row ends in a link glyph.
 */
function TreeHead({
  line,
  icon,
  pillInRow,
  children,
}: {
  line: NodeLine;
  icon: ReactNode;
  /**
   * The row's own box carries the pill's per-depth step (`outline`: the
   * table moves the row by `DataTableTree.pillIndent`), so the head pays only
   * the content's share of the indent. Else (a ruled `grid` row) the head
   * pays all of it.
   */
  pillInRow: boolean;
  children: ReactNode;
}): ReactNode {
  const ctx = useTreeContext<Row>();
  const { node, depth } = line;
  const hasChildren =
    node.children.length > 0 || (ctx.lazyChildren?.hasChildren(node) ?? false);
  return (
    <Stack
      direction="row"
      align="center"
      gap="none"
      // `relative`: the box the guides are placed in. `min-w-0`: the cell, a
      // truncating leaf, may shrink inside it. `overflow-hidden`: a deep row
      // whose indent outgrows the track is cut at the track's edge instead of
      // painting over the next column.
      // eslint-disable-next-line layout/no-adhoc-layout -- the tree head is the first grid cell's box: the guides' positioning context, shrinkable so the label truncates, clipped to its track
      className="relative min-w-0 overflow-hidden gap-tree-row"
      style={
        pillInRow
          ? { paddingLeft: treeRowIndentStyle(depth).paddingLeft }
          : treeRowIndentStyle(depth)
      }
    >
      <TreeLeading
        depth={depth}
        hasChildren={hasChildren}
        isOpen={node.expanded}
        onToggle={() =>
          void ctx.setExpanded([{ id: node.id, expanded: !node.expanded }])
        }
        icon={icon}
        guides={ctx.guides}
      />
      {children}
      {node.alias && (
        <Icon icon={linkIcon} className="size-3.5 text-muted-foreground" />
      )}
    </Stack>
  );
}

/**
 * The table view over a hierarchical source: rows nest. The shared hierarchy
 * pipeline (`useHierarchyTree` — projection with aliases, the filter under its
 * `filterScope`, a stable global sort, i.e. a sort within each sibling group)
 * feeds the tree primitive's model, whose flattened visible lines become the
 * table's rows. The table never builds a tree; it draws `model.flat` with the
 * tree's own pieces: `TreeLeading` in the first cell, `useTreeRow` +
 * `treeRowGestures` + `TreeDropZones` on each row through `useRowDecoration`,
 * `useTreeKeyboard` on the grid, the lazy placeholder as a full-span line.
 *
 * It bypasses `useDataViewSections`: no flat sort (the sort is per sibling
 * group), no fold, no aggregate, no paging (a hierarchy is never paged) and no
 * flat manual order — a nested row's order is its rank, reordered by the
 * tree's own drag (before / after / into), which any sort suspends.
 */
export function NestedTableView(
  props: DataViewRenderProps<unknown>,
): ReactNode {
  // Documented cast boundary: `options` is `viewOptions.table`, opaque to the
  // host; `fields` / `itemActions` arrive type-erased.
  const options = useMemo(
    () => (props.options ?? {}) as TableViewOptions<unknown>,
    [props.options],
  );
  const fields = props.fields as FieldDef<unknown>[];
  const itemActions = props.itemActions as
    ItemActionsDescriptor<unknown> | undefined;
  const resolveCell = useResolveCell();
  const resolveEditor = useResolveCellEditor();
  // An outline is a tree's look: like a tree row, it reserves no permanent
  // region for actions (a sidebar's labels keep the width), so the persistent
  // zone demotes to the hover cluster there.
  const { persistent, revealed } = useItemActionZones(itemActions, {
    hasPersistentSlot: options.presentation !== "outline",
  });

  // Columns follow the view's Properties policy. The leading field (the row's
  // avatar) renders in the tree head's icon slot, so it is no column here.
  const vis = useMemo(
    () => resolveBodyFields(fields, props.state.visibleFields),
    [fields, props.state.visibleFields],
  );
  const leadingField = useMemo(() => pickLeadingField(vis), [vis]);
  const columnFields = useMemo(
    () => vis.filter((f) => f !== leadingField),
    [vis, leadingField],
  );
  const primaryField = useMemo(
    () => pickPrimaryField(columnFields),
    [columnFields],
  );
  // An alias (reference) row is read-only: its cells draw without editors.
  const readOnlyFields = useMemo(
    () =>
      new Map(
        columnFields.map((f) => [
          f.id,
          { ...f, onEdit: undefined, onEditValues: undefined },
        ]),
      ),
    [columnFields],
  );

  const hierarchy = useHierarchyTree({ props, primaryField, options });
  const { treeArgs } = hierarchy;
  const model = useTreeModel({
    ...treeArgs,
    rows: hierarchy.rows,
    search: hierarchy.search,
    rootId: options.rootId,
    guides: options.guides,
    multiSelect: !!props.selection,
  });
  // Arrow keys walk the painted lines. Rows are focusable exactly when the
  // view has an open gesture, so that is what turns the keys on (as in the tree).
  const keyboard = useTreeKeyboard({
    flatNodes: model.flat,
    enabled: !!treeArgs.onOpen,
    selectedId: props.selectedRowId,
    onSelect: treeArgs.onSelect,
    setExpanded: props.setExpanded,
    lazyChildren: treeArgs.lazyChildren,
  });
  const { canReorder, canCreate } = model.context;
  // The toolbar's whole-table expand-all, over the rows in scope — the same
  // hook `TreeList` runs over its own.
  const viewExpandAll = useFlatExpandAll(model.scoped, props.setExpanded);

  // Grouped: the ROOTS partition into sections and every descendant follows
  // its root (`useHierarchyTree`), so each line's section is its owner row's.
  const grouped = hierarchy.grouped;
  const sectionOf = useMemo(() => {
    if (!grouped) return null;
    const map = new Map<string, string>();
    for (const [key, rows] of grouped.rowsBySectionKey) {
      for (const row of rows) map.set(row.id, key);
    }
    return map;
  }, [grouped]);

  // One DnD context spans every section, so a cross-section drop is refused
  // here: a drop beside another section's root would write a position whose
  // group value the drop cannot change (the row would land back in its own
  // section), and the tree view refuses it too (one context per section).
  const modelOnDragEnd = model.onDragEnd;
  const onDragEnd = useCallback(
    (event: Parameters<typeof modelOnDragEnd>[0]) => {
      if (sectionOf) {
        const dragged = event.active.data.current?.id as string | undefined;
        const target = event.over?.data.current?.targetId as string | undefined;
        if (
          dragged !== undefined &&
          target !== undefined &&
          sectionOf.get(dragged) !== sectionOf.get(target)
        ) {
          return;
        }
      }
      modelOnDragEnd(event);
    },
    [sectionOf, modelOnDragEnd],
  );

  if (hierarchy.rows.length === 0 && props.emptyState !== undefined) {
    return <>{props.emptyState}</>;
  }

  // The label's per-row emphasis: the host's `rowTone`, then the surface's
  // own class (which wins), on the first cell — as the tree's label.
  const labelClass = (row: unknown) =>
    cn(rowToneClass(props.rowTone?.(row)), options.labelClassName?.(row));
  const columns: ColumnDef<Line>[] = columnFields.map((f, i) => ({
    id: f.id,
    header: f.header === false ? "" : (f.header ?? f.label),
    // The first column — the tree's label — takes the slack, as a tree row's
    // label does, floored at the tree's label floor (10rem) so the other
    // columns cannot squeeze it away; the others are as wide as their content.
    width: f.width ?? (i === 0 ? "minmax(10rem, 1fr)" : undefined),
    align: f.align,
    dropOrder: f.dropOrder,
    // The host's sortable set: a header click sorts every sibling group.
    sortable: props.sortHeader.sortable.has(f.id),
    cell: (line: Line) => {
      if (line.kind !== "node") return null;
      const { node } = line;
      const row = node.__row;
      if (f !== primaryField) {
        return (
          <FieldCell
            field={node.alias ? readOnlyFields.get(f.id)! : f}
            row={row}
            resolveCell={resolveCell}
            resolveEditor={resolveEditor}
          />
        );
      }
      // The label: the tree row's own — select-then-edit when the field
      // writes back (it is the navigation target, so it has no room for a
      // pencil, and a created row opens straight into it), read-only on an
      // alias — classed by the row's tone and the surface's label class.
      const tone = labelClass(row);
      if (!node.alias && (f.onEdit != null || f.onEditValues != null)) {
        const value = f.value?.(row);
        const read = f.cell
          ? f.cell(row)
          : (resolveCell(f, value ?? null, row) ?? readFallback(f, value));
        return (
          <EditableTreeLabel
            node={node}
            row={row}
            field={f}
            read={read}
            className={tone || undefined}
          />
        );
      }
      const cell = (
        <FieldCell
          field={node.alias ? readOnlyFields.get(f.id)! : f}
          row={row}
          resolveCell={resolveCell}
          resolveEditor={resolveEditor}
        />
      );
      return tone ? <span className={tone}>{cell}</span> : cell;
    },
  }));

  const tree: DataTableTree<Line> = {
    leading: (line, cell) =>
      line.kind === "node" ? (
        <TreeHead
          line={line}
          pillInRow={options.presentation === "outline"}
          icon={leadingSlot({
            field: leadingField,
            row: line.node.__row,
            resolveCell,
            resolveEditor,
            own: options.leadingIcon?.(line.node.__row),
          })}
        >
          {cell}
        </TreeHead>
      ) : (
        cell
      ),
    fullSpan: (line) =>
      line.kind === "placeholder" ? (
        <TreeChildPlaceholder
          placeholder={line.placeholder}
          depth={line.depth}
          guides={options.guides}
        />
      ) : null,
    containerRef: keyboard.containerRef,
    onKeyDown: keyboard.onKeyDown,
    // The first column's label over the rows' labels: a depth-0 row's lead
    // inset and disclosure slot (where the tree's aligned header put it).
    headerLeading: (label) => (
      <Stack
        as="span"
        direction="row"
        align="center"
        gap="none"
        className="gap-tree-row"
        style={{ paddingLeft: treeRowIndentStyle(0).paddingLeft }}
      >
        <span className="size-5" aria-hidden />
        {label}
      </Stack>
    ),
    // The pill steps in with the depth, as a tree row's (`treeRowIndentStyle`).
    pillIndent: (line) => `calc(${line.depth} * var(--tree-pill-indent))`,
  };

  // Per-row decoration HOOK (called inside DataTable's row component): the
  // row is a tree row — its controls (`useTreeRow`: drag source, the
  // before / after / into droppables, the reveal), gestures (select, link,
  // open), ARIA and `data-tree-*` attributes, and its drop zones. Only node
  // lines reach it: a placeholder is a full-span line, never a decorated row.
  const windowed =
    !grouped && model.flat.length > DATA_TABLE_VIRTUALIZE_THRESHOLD;
  // An outline's top-level rows stand apart as a tree's roots do
  // (`TreeList`'s `gap-tree-root`; a windowed tree's rows sit flush, as here).
  const rootGap = options.presentation === "outline" && !windowed;
  const rowMenu = options.rowMenu;
  function useRowDecoration(
    line: Line,
    index: number,
  ): DataTableRowDecoration | undefined {
    const node = (line as NodeLine).node;
    const controls = useTreeRow(node);
    const accent = options.rowAccent?.(node.__row);
    const { childRef, dragSource } = controls;
    // A reference row has no position of its own: never a drag source.
    const draggable = canReorder && !node.alias;
    const dragRef = dragSource.ref;
    const ref = useCallback(
      (el: HTMLElement | null) => {
        childRef(el);
        if (draggable) dragRef(el);
      },
      [childRef, dragRef, draggable],
    );
    const gestures = treeRowGestures({
      onSelect: controls.select,
      selectHref: controls.selectHref,
      onOpen: controls.open,
      clickOpens: controls.clickOpens,
    });
    // The row's revealed cluster, from its own controls (`treeRowTrailing`,
    // the one `RowChrome` uses): `null` when it offers nothing, so no empty
    // cluster mounts on it. An alias has none.
    const actions = node.alias
      ? null
      : (treeRowTrailing({
          actions: revealed?.({
            row: node.__row,
            hasChildren: node.children.length > 0,
          }),
          menu: rowMenu
            ? (helpers: RowMenuHelpers) => rowMenu(helpers, node.__row)
            : undefined,
          childCount: node.children.length,
          controls,
          canCreate,
        }) ?? null);
    return {
      ref,
      actions,
      props: {
        ...gestures,
        ...(draggable ? dragSource.attributes : {}),
        ...(draggable ? dragSource.listeners : {}),
        role: "row",
        "aria-level": (line as NodeLine).depth + 1,
        "aria-expanded": controls.hasChildren ? controls.isOpen : undefined,
        "aria-selected": controls.isSelected,
        "data-tree-row": true,
        "data-tree-id": node.id,
        // An alias is a second drawing of a row the real node already marks.
        "data-row-key": node.alias ? undefined : node.id,
      },
      className: cn(
        // The named group the disclosure's hover reveal reads.
        "group/tree-row",
        // A focusable row (one with an open gesture) is walked with the arrow
        // keys, so the row the keys are on must show it.
        controls.open && "focus-ring",
        controls.isDragging && "opacity-40",
        controls.isOverChild && "ring-1 ring-primary/40",
      ),
      // A nested row sits flush on its parent; a root stands apart.
      style:
        rootGap && (line as NodeLine).depth === 0 && index > 0
          ? { marginTop: "var(--tree-root-gap)" }
          : undefined,
      // A drop onto the row nests under it: the row reads highlighted.
      highlighted: controls.isOverChild,
      // Everything in the row reads its controls, as inside a `RowChrome`:
      // the trailing cluster, and any cell or item action asking
      // `useOptionalRowControls`.
      provide: (content) => (
        <RowControlsProvider value={controls}>{content}</RowControlsProvider>
      ),
      overlay: (
        <>
          {accent != null && (
            // eslint-disable-next-line layout/no-adhoc-layout -- full-bleed accent wash painted over the row (RowChrome's own accent layer)
            <div aria-hidden className="pointer-events-none absolute inset-0">
              {accent}
            </div>
          )}
          <TreeDropZones
            beforeRef={controls.beforeRef}
            afterRef={controls.afterRef}
            isOverBefore={controls.isOverBefore}
            isOverAfter={controls.isOverAfter}
          />
        </>
      ),
    };
  }

  // The trailing cluster: the consumer's item actions, then the tree's own
  // chrome — fold / unfold the subtree, the row menu, add a child — which is
  // the tree row's own cluster (`TreeRowActions`, reading the controls the
  // decoration provides). A reference row has none.
  const nodeOf = (line: Line) =>
    line.kind === "node" && !line.node.alias ? line.node : null;
  const anyChildren = model.flat.some(
    (l) => l.kind === "node" && l.node.children.length > 0,
  );
  const rowActions =
    revealed || canCreate || anyChildren || rowMenu
      ? (line: Line) => {
          const node = nodeOf(line);
          if (!node) return null;
          return (
            <TreeRowActions
              actions={revealed?.({
                row: node.__row,
                hasChildren: node.children.length > 0,
              })}
              menu={
                rowMenu ? (helpers) => rowMenu(helpers, node.__row) : undefined
              }
              childCount={node.children.length}
            />
          );
        }
      : undefined;
  // At rest at the row's end: the surface's `trailing` (a badge, a count —
  // after every column, where a tree row puts it after its chips), then the
  // persistent item actions. Capped, so one row's wide trailing cannot take
  // the label column's room from every row: past the cap it clips.
  const trailing = options.trailing;
  const rowPersistentActions =
    persistent || trailing
      ? (line: Line) => {
          const node = nodeOf(line);
          if (!node) return null;
          return (
            <>
              {trailing && (
                <Clip axis="x" style={TRAILING_CAP}>
                  {trailing(node.__row)}
                </Clip>
              )}
              {persistent?.({
                row: node.__row,
                hasChildren: node.children.length > 0,
              })}
            </>
          );
        }
      : undefined;

  const shared = {
    columns,
    rowKey: lineKey,
    sortState: mapPrimary(props.sortHeader.active),
    onToggleSort: (columnId: string) => props.setSort(columnId),
    selectedRowId: props.selectedRowId,
    emptyLabel: "No results found",
    rowActions,
    rowPersistentActions,
    stickyHeaderOffset: `var(${DATA_VIEW_HEADER_OFFSET_VAR}, 0px)`,
    // A row's toggle folds the lines it reveals or hides.
    openKeys: model.openKeys,
    useRowDecoration,
    columnHeader: options.columnHeader,
    density: props.density,
    presentation: options.presentation,
    header: options.header,
    tree,
    selection: props.selection
      ? { actions: props.selection.bulkActions }
      : undefined,
  };

  // The tree's chrome around the rows: a toolbar row (expand-all, the
  // surface's own start content) and the root Add — the tree view's, through
  // the same components.
  const showExpandAll = !!options.expandAll && viewExpandAll.hasExpandable;
  const showToolbar = showExpandAll || options.toolbarStart != null;
  // An explicit `null` hides the root Add; only an absent option falls back.
  const addLabel =
    options.rootId === undefined && canCreate && treeArgs.onCreate
      ? options.addLabel !== undefined
        ? options.addLabel
        : "Add"
      : null;

  const renderTable = (activeId: string | null): ReactNode =>
    grouped ? (
      <DataTable
        data={[]}
        groups={grouped.sections.map((section): DataTableGroup<Line> => {
          const key = section.key!;
          const collapsed = props.collapsedSections?.has(key) ?? false;
          return {
            key,
            collapsed,
            rows: model.flat.filter(
              (line) => sectionOf!.get(lineOwner(line).id) === key,
            ),
            header: (
              <DataViewGroupHeader
                section={section}
                headerStyle={props.groupHeaders}
                open={!collapsed}
                onClick={() => props.setSectionCollapsed?.(key, !collapsed)}
                // Fold / unfold this group's subtrees (a group holds whole
                // subtrees: every descendant follows its root).
                action={groupFoldAction(
                  grouped.rowsBySectionKey.get(key)!,
                  props.setExpanded,
                )}
              />
            ),
          };
        })}
        {...shared}
      />
    ) : (
      <DataTable
        data={model.flat}
        // Kept mounted when the window scrolls past them: the drag source
        // (its draggable would unregister and cancel the drop) and the
        // selected row (the keyboard's focus rides the selection).
        keepMountedRowKeys={[activeId, props.selectedRowId].filter(
          (id): id is string => id != null,
        )}
        {...shared}
      />
    );

  return (
    <RankReorderDndContext
      onDragEnd={onDragEnd}
      dragOverlay={model.dragChip}
      // A windowed body mounts rows as it scrolls; re-measure droppables every
      // frame so a freshly mounted row is a valid drop target mid-drag.
      measuringAlways={windowed}
    >
      {(activeId) => (
        <TreeProvider value={model.context}>
          {showToolbar && (
            <div className="rail-follow">
              <TreeToolbar
                start={options.toolbarStart}
                expandAll={
                  showExpandAll
                    ? {
                        allExpanded: viewExpandAll.allExpanded,
                        onToggle: viewExpandAll.toggle,
                      }
                    : undefined
                }
              />
            </div>
          )}
          {renderTable(activeId)}
          {addLabel != null && (
            <div className="rail-follow">
              <TreeRootAdd
                label={addLabel}
                onAdd={() => void model.createAtRoot(null)}
              />
            </div>
          )}
        </TreeProvider>
      )}
    </RankReorderDndContext>
  );
}
