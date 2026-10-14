import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { ExpandAllButton } from "@plugins/primitives/plugins/collapsible/web";
import { RankReorderDndContext } from "@plugins/primitives/plugins/rank-reorder/web";
import type { TreeNode } from "../../core";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import {
  MultiSelectProvider,
  SelectionBar,
} from "@plugins/primitives/plugins/multi-select/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { VirtualRows } from "@plugins/primitives/plugins/virtual-rows/web";
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
 * VirtualRows. Below it the recursive render runs unchanged. Mirrors the list
 * view's threshold. */
const VIRTUALIZE_THRESHOLD = 100;
/** Initial per-row height estimate (the default `treeRowH` 28px row + py-xs). Dynamic measurement
 * refines it after mount. */
const ROW_ESTIMATE_PX = 32;

export type TreeListProps<T extends TreeItem> = Omit<
  TreeModelArgs<T>,
  "search" | "multiSelect"
> & {
  /** The component used to render every row. Recursion through children is
   * handled by RowChrome (which reads this from context). */
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
  const { flat, orderedIds, visibleTree } = model;

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
    () => ({ ...model.context, Row, windowed }),
    [model.context, Row, windowed],
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
                {windowed ? (
                  <VirtualRows
                    items={flat}
                    estimateSize={ROW_ESTIMATE_PX}
                    getKey={(item) =>
                      item.kind === "node"
                        ? item.node.id
                        : `\u0000placeholder:${item.parent.id}`
                    }
                    scrollToIndex={selectedIndex}
                    // Pin the drag source so it stays mounted when scrolled out of
                    // the window — otherwise its draggable unregisters mid-gesture
                    // and dnd-kit cancels the drop.
                    keepMounted={activeId ? [activeId] : undefined}
                  >
                    {(item) =>
                      item.kind === "node" ? (
                        <TreeRowSlot node={item.node} depth={item.depth} />
                      ) : (
                        <TreeChildPlaceholder
                          placeholder={item.placeholder}
                          depth={item.depth}
                          guides={guides}
                        />
                      )
                    }
                  </VirtualRows>
                ) : (
                  visibleTree.map((node) => (
                    <TreeRowSlot key={node.id} node={node} depth={0} />
                  ))
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
