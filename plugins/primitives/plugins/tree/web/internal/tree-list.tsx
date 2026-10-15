import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { ExpandAllButton } from "@plugins/primitives/plugins/collapsible/web";
import { RankReorderDndContext } from "@plugins/primitives/plugins/rank-reorder/web";
import type { FlatTreeLine, TreeNode } from "../../core";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import {
  MultiSelectProvider,
  SelectionBar,
} from "@plugins/primitives/plugins/multi-select/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { VirtualRows } from "@plugins/primitives/plugins/virtual-rows/web";
import { useRowFold } from "@plugins/primitives/plugins/virtual-rows/plugins/row-fold/web";
import { KeepScrollAcross } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { TreeListProvider, TreeRowSlot } from "./use-tree-row";
import { useFlatExpandAll } from "./use-flat-expand-all";
import { TreeChildPlaceholder } from "./tree-child-placeholder";
import { useTreeKeyboard } from "./use-tree-keyboard";
import { useTreeModel, type TreeModelArgs } from "./use-tree-model";
import type { TreeItem } from "./types";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");

/** Above this many *visible* (expanded) rows the tree windows its rows via
 * VirtualRows. Below it the same flat lines are drawn whole. Mirrors the list
 * view's threshold. */
const VIRTUALIZE_THRESHOLD = 100;
/** Initial per-row height estimate (the default `treeRowH` 28px row + py-xs). Dynamic measurement
 * refines it after mount. */
const ROW_ESTIMATE_PX = 32;

export type TreeListProps<T extends TreeItem> = Omit<
  TreeModelArgs<T>,
  "search" | "multiSelect"
> & {
  /** The component used to render every row (each line of the flattened
   * tree; nothing recurses). */
  Row: (props: { node: TreeNode<T>; depth: number }) => ReactNode;
  toolbar?: {
    expandAll?: boolean;
    search?: {
      accessor: (row: T) => string;
      /** Controlled query value. When set, used instead of TreeList's own state. */
      query?: string;
      /** Hide TreeList's own SearchInput (a host toolbar renders one). */
      hideInput?: boolean;
    };
    /** Extra content rendered on the left side of the toolbar row. */
    start?: ReactNode;
  };
  /** Root-level "Add" button label. Pass `null` to hide (e.g. subtree mode). */
  addLabel?: string | null;
  /**
   * Opt-in checkbox multi-select. Present → each row renders a `SelectionCheckbox`
   * and a `SelectionBar` (with optional bulk `actions`) sits above the rows. The
   * select order is derived from the visible tree (DFS, skipping collapsed
   * subtrees) so shift-range selection matches exactly what is painted.
   */
  multiSelect?: { actions?: ReactNode };
};

export function TreeList<T extends TreeItem>(props: TreeListProps<T>) {
  const {
    rootId,
    selectedId,
    revealSelected = true,
    onSelect,
    setExpanded,
    onCreate,
    Row,
    toolbar,
    addLabel = "Add",
    canCreate = true,
    multiSelect,
    lazyChildren,
    onOpen,
    guides = false,
  } = props;

  const [searchQuery, setSearchQuery] = useState("");
  const searchAccessor = toolbar?.search?.accessor;
  // Controlled when `query` is supplied (host toolbar drives it); else internal.
  const effectiveQuery = toolbar?.search?.query ?? searchQuery;
  const hideSearchInput = toolbar?.search?.hideInput ?? false;

  const model = useTreeModel({
    ...props,
    search: searchAccessor
      ? { accessor: searchAccessor, query: effectiveQuery }
      : undefined,
    multiSelect: !!multiSelect,
  });
  const { flat, orderedIds } = model;

  // Arrow-key navigation over the painted rows. Rows are focusable exactly when
  // the tree has an open gesture, so that is what turns the keys on.
  const keyboard = useTreeKeyboard({
    flatNodes: flat,
    enabled: !!onOpen,
    selectedId,
    onSelect,
    setExpanded,
    lazyChildren,
  });

  const windowed = flat.length > VIRTUALIZE_THRESHOLD;
  // The rows column survives the plain ⇄ windowed swap (only its children are
  // replaced), so it is the anchor KeepScrollAcross finds the scroller from.
  const rootRef = useRef<HTMLElement | null>(null);
  const keyboardRef = keyboard.containerRef;
  const setRoot = useCallback(
    (el: HTMLElement | null) => {
      rootRef.current = el;
      keyboardRef(el);
    },
    [keyboardRef],
  );
  const selectedIndex = useMemo(() => {
    if (!windowed || !selectedId || !revealSelected) return undefined;
    const i = flat.findIndex(
      (f) => f.kind === "node" && f.node.id === selectedId,
    );
    return i >= 0 ? i : undefined;
  }, [windowed, selectedId, revealSelected, flat]);

  // The toolbar's whole-tree expand-all. Shared with the grouped tree view's
  // hoisted toolbar and its per-section header toggle, which hold row buckets
  // rather than a forest — hence the flat-rows shape.
  const {
    hasExpandable,
    allExpanded,
    toggle: expandAll,
  } = useFlatExpandAll(model.scoped, setExpanded);
  const showExpandAll = !!toolbar?.expandAll && hasExpandable;

  const showSearchInput = !!toolbar?.search && !hideSearchInput;
  const hasToolbar = showExpandAll || !!toolbar?.start || showSearchInput;
  const showRootAdd = !rootId && addLabel != null && canCreate && !!onCreate;

  const ctxValue = useMemo(
    () => ({ ...model.context, Row }),
    [model.context, Row],
  );

  return (
    <RankReorderDndContext
      onDragEnd={model.onDragEnd}
      dragOverlay={model.dragChip}
      // In windowed mode rows mount/unmount as the user scrolls; the shell's
      // MeasuringStrategy.Always re-measures droppables each frame so freshly
      // mounted rows become valid drop targets mid-drag.
      measuringAlways={windowed}
    >
      {(activeId) => (
        <TreeListProvider value={ctxValue}>
          <MaybeMultiSelect multiSelect={multiSelect} orderedIds={orderedIds}>
            {/* Crossing the windowing threshold (opening a big folder) swaps
                every row out at once; keep the reader where they were. */}
            <KeepScrollAcross swapKey={windowed} anchorRef={rootRef}>
              <Stack
                gap="none"
                className="gap-tree-root"
                ref={setRoot}
                onKeyDown={keyboard.onKeyDown}
              >
                {hasToolbar && (
                  // eslint-disable-next-line spacing/no-adhoc-spacing -- mb separates the sticky toolbar from the tree rows below (no named margin utility)
                  <Sticky mask className="mb-1">
                    <Stack
                      direction="row"
                      gap="xs"
                      align="center"
                      justify="between"
                    >
                      <Stack direction="row" gap="xs" align="center">
                        {showSearchInput && (
                          <SearchInput
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") {
                                setSearchQuery("");
                                (e.target as HTMLInputElement).blur();
                              }
                            }}
                            placeholder="Filter…"
                            className="w-32"
                          />
                        )}
                        {toolbar.start}
                      </Stack>
                      <Stack direction="row" gap="xs" align="center">
                        {showExpandAll && (
                          <ExpandAllButton
                            allExpanded={allExpanded}
                            onToggle={expandAll}
                          />
                        )}
                      </Stack>
                    </Stack>
                  </Sticky>
                )}
                {multiSelect && <SelectionBar actions={multiSelect.actions} />}
                {/* The rows are `flat` in both modes — one list, so a toggle
                    folds the rows it reveals or hides the same way (row-fold:
                    transform / clip / opacity, never a per-frame relayout of
                    every row below), windowed or not. */}
                {windowed ? (
                  <VirtualRows
                    items={flat}
                    estimateSize={ROW_ESTIMATE_PX}
                    getKey={lineKey}
                    scrollToIndex={selectedIndex}
                    openKeys={model.openKeys}
                    isStandIn={isPlaceholder}
                    // Pin the drag source so it stays mounted when scrolled out of
                    // the window — otherwise its draggable unregisters mid-gesture
                    // and dnd-kit cancels the drop.
                    keepMounted={activeId ? [activeId] : undefined}
                  >
                    {(item, index) => (
                      <TreeLine
                        item={item}
                        first={index === 0}
                        guides={guides}
                      />
                    )}
                  </VirtualRows>
                ) : (
                  <PlainRows
                    flat={flat}
                    openKeys={model.openKeys}
                    guides={guides}
                  />
                )}
                {showRootAdd && (
                  <Button
                    variant="ghost"
                    onClick={() => void model.createAtRoot(null)}
                    // eslint-disable-next-line spacing/no-adhoc-spacing -- mt offsets the root Add button from the tree rows above (no named margin utility)
                    className="text-muted-foreground mt-1 w-fit"
                  >
                    <Icon icon={addIcon} className="size-4" />
                    {addLabel}
                  </Button>
                )}
              </Stack>
            </KeepScrollAcross>
          </MaybeMultiSelect>
        </TreeListProvider>
      )}
    </RankReorderDndContext>
  );
}

/** A painted line's key: a row's node id; a placeholder's is derived from its
 *  parent's, NUL-prefixed so it can never be a row id. */
function lineKey<T extends TreeItem>(line: FlatTreeLine<T>): string {
  return line.kind === "node"
    ? line.node.id
    : `\u0000placeholder:${line.parent.id}`;
}

/** An open lazy node's placeholder child stands in for the children it has
 *  not listed yet: when they land, they fold in as it folds out. */
function isPlaceholder<T extends TreeItem>(line: FlatTreeLine<T>): boolean {
  return line.kind === "placeholder";
}

/**
 * The tree's unwindowed rows: `flat` drawn as one list, folding through
 * row-fold like the windowed one (`VirtualRows` runs the same hook).
 */
function PlainRows<T extends TreeItem>({
  flat,
  openKeys,
  guides,
}: {
  flat: readonly FlatTreeLine<T>[];
  openKeys: ReadonlySet<string>;
  guides: boolean;
}): ReactNode {
  const fold = useRowFold({
    items: flat,
    getKey: lineKey,
    openKeys,
    isStandIn: isPlaceholder,
  });
  return (
    <div {...fold.hostProps}>
      {fold.items.map((item, index) => {
        const key = lineKey(item);
        return (
          <div key={key} {...fold.rowProps(key)}>
            <TreeLine item={item} first={index === 0} guides={guides} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * One painted line: a node's row, or an open lazy node's placeholder child. A
 * root row after the first keeps the root gap above it — inside its own box,
 * so the fold, which measures boxes, carries the gap with the row.
 */
function TreeLine<T extends TreeItem>({
  item,
  first,
  guides,
}: {
  item: FlatTreeLine<T>;
  first: boolean;
  guides: boolean;
}): ReactNode {
  const line =
    item.kind === "node" ? (
      <TreeRowSlot node={item.node} depth={item.depth} />
    ) : (
      <TreeChildPlaceholder
        placeholder={item.placeholder}
        depth={item.depth}
        guides={guides}
      />
    );
  if (first || item.depth > 0) return line;
  return <div style={{ paddingTop: "var(--tree-root-gap)" }}>{line}</div>;
}

/**
 * Wraps the rows column in a `MultiSelectProvider` only when multi-select is
 * enabled, so the default tree renders with no provider (and no behavior change).
 */
function MaybeMultiSelect({
  multiSelect,
  orderedIds,
  children,
}: {
  multiSelect: { actions?: ReactNode } | undefined;
  orderedIds: readonly string[];
  children: ReactNode;
}) {
  if (!multiSelect) return <>{children}</>;
  return (
    <MultiSelectProvider orderedIds={orderedIds}>
      {children}
    </MultiSelectProvider>
  );
}
