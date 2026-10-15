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
  FieldCell,
  leadingSlot,
  pickLeadingField,
  pickPrimaryField,
  resolveBodyFields,
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
import type { FlatTreeLine } from "@plugins/primitives/plugins/tree/core";
import {
  TreeChildPlaceholder,
  TreeDropZones,
  TreeLeading,
  TreeListProvider,
  treeRowGestures,
  treeRowIndentStyle,
  useTreeKeyboard,
  useTreeListContext,
  useTreeModel,
  useTreeRow,
  type TreeListContextValue,
} from "@plugins/primitives/plugins/tree/web";
import { RankReorderDndContext } from "@plugins/primitives/plugins/rank-reorder/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { TableViewOptions } from "../../core";
import { mapPrimary } from "../internal/map-primary";

const addIcon = symbol("add");
const linkIcon = symbol("link");
const unfoldLessIcon = symbol("unfold-less");
const unfoldMoreIcon = symbol("unfold-more");

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
 * The table paints the flattened tree itself, so no row recurses through the
 * tree context's `Row` — the context still carries one (the tree's own rows
 * read it), and reaching this one would mean a `TreeList` row rendered inside
 * a table, which nothing does.
 */
function noRecursiveRow(): never {
  throw new Error(
    "NestedTableView: a table paints its flattened tree; no row recurses",
  );
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
  children,
}: {
  line: NodeLine;
  icon: ReactNode;
  children: ReactNode;
}): ReactNode {
  const ctx = useTreeListContext<Row>();
  const { node, depth } = line;
  const hasChildren =
    node.children.length > 0 || (ctx.lazyChildren?.hasChildren(node) ?? false);
  return (
    <Stack
      direction="row"
      align="center"
      gap="none"
      // `relative`: the box the guides are placed in. `min-w-0`: the cell, a
      // truncating leaf, may shrink inside it.
      // eslint-disable-next-line layout/no-adhoc-layout -- the tree head is the first grid cell's box: the guides' positioning context, shrinkable so the label truncates
      className="relative min-w-0 gap-tree-row"
      style={treeRowIndentStyle(depth)}
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
  const { persistent, revealed } = useItemActionZones(itemActions, {
    hasPersistentSlot: true,
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
  const ctxValue = useMemo<TreeListContextValue<Row>>(
    () => ({ ...model.context, Row: noRecursiveRow }),
    [model.context],
  );
  const { canReorder, canCreate, subtreeAllExpanded, toggleSubtreeExpanded } =
    model.context;

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

  const modelCreate = model.createAtRoot;
  const setExpanded = props.setExpanded;
  // Add-child: open the row (so the new child is not created out of sight),
  // then create under it — `createAtRoot` selects and focuses what it made.
  const addChild = useCallback(
    async (id: string) => {
      setExpanded([{ id, expanded: true }]);
      await modelCreate(id);
    },
    [setExpanded, modelCreate],
  );

  if (hierarchy.rows.length === 0 && props.emptyState !== undefined) {
    return <>{props.emptyState}</>;
  }

  const columns: ColumnDef<Line>[] = columnFields.map((f) => ({
    id: f.id,
    header: f.header === false ? "" : (f.header ?? f.label),
    width: f.width,
    align: f.align,
    dropOrder: f.dropOrder,
    // The host's sortable set: a header click sorts every sibling group.
    sortable: props.sortHeader.sortable.has(f.id),
    cell: (line: Line) =>
      line.kind === "node" ? (
        <FieldCell
          field={line.node.alias ? readOnlyFields.get(f.id)! : f}
          row={line.node.__row}
          resolveCell={resolveCell}
          resolveEditor={resolveEditor}
        />
      ) : null,
  }));

  const tree: DataTableTree<Line> = {
    leading: (line, cell) =>
      line.kind === "node" ? (
        <TreeHead
          line={line}
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
  };

  // Per-row decoration HOOK (called inside DataTable's row component): the
  // row is a tree row — its controls (`useTreeRow`: drag source, the
  // before / after / into droppables, the reveal), gestures (select, link,
  // open), ARIA and `data-tree-*` attributes, and its drop zones. Only node
  // lines reach it: a placeholder is a full-span line, never a decorated row.
  function useRowDecoration(line: Line): DataTableRowDecoration | undefined {
    const node = (line as NodeLine).node;
    const controls = useTreeRow(node);
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
    return {
      ref,
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
      // A drop onto the row nests under it: the row reads highlighted.
      highlighted: controls.isOverChild,
      overlay: (
        <TreeDropZones
          beforeRef={controls.beforeRef}
          afterRef={controls.afterRef}
          isOverBefore={controls.isOverBefore}
          isOverAfter={controls.isOverAfter}
        />
      ),
    };
  }

  // The trailing cluster: the consumer's item actions, then the tree's own
  // chrome — fold / unfold the subtree, add a child. A reference row has none.
  const nodeOf = (line: Line) =>
    line.kind === "node" && !line.node.alias ? line.node : null;
  const anyChildren = model.flat.some(
    (l) => l.kind === "node" && l.node.children.length > 0,
  );
  const rowActions =
    revealed || canCreate || anyChildren
      ? (line: Line) => {
          const node = nodeOf(line);
          if (!node) return null;
          const allOpen = subtreeAllExpanded(node.id);
          return (
            <>
              {revealed?.({
                row: node.__row,
                hasChildren: node.children.length > 0,
              })}
              {node.children.length > 0 && (
                <IconButton
                  icon={allOpen ? unfoldLessIcon : unfoldMoreIcon}
                  label={allOpen ? "Collapse subtree" : "Expand subtree"}
                  variant="ghost"
                  onClick={() => toggleSubtreeExpanded(node.id)}
                />
              )}
              {canCreate && (
                <IconButton
                  icon={addIcon}
                  label="Add child"
                  variant="ghost"
                  onClick={() => void addChild(node.id)}
                />
              )}
            </>
          );
        }
      : undefined;
  const rowPersistentActions = persistent
    ? (line: Line) => {
        const node = nodeOf(line);
        return node
          ? persistent({
              row: node.__row,
              hasChildren: node.children.length > 0,
            })
          : null;
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
    tree,
    selection: props.selection
      ? { actions: props.selection.bulkActions }
      : undefined,
  };

  const windowed =
    !grouped && model.flat.length > DATA_TABLE_VIRTUALIZE_THRESHOLD;

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
        <TreeListProvider value={ctxValue}>
          {renderTable(activeId)}
        </TreeListProvider>
      )}
    </RankReorderDndContext>
  );
}
