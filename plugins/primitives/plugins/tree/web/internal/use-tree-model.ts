import {
  PLAIN_GESTURE,
  type Gesture,
} from "@plugins/primitives/plugins/link-gesture/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { filterTree } from "@plugins/primitives/plugins/search/web";
import {
  buildTree,
  childPlaceholder,
  createTreeSharing,
  flatNodeIds,
  flattenVisible,
  isDescendant,
  resolveDropParent,
  type DropZone,
  type ExpandChange,
  type FlatTreeLine,
  type LazyChildren,
  type TreeNode,
} from "../../core";
import { useSubtreeExpandIndex } from "./use-subtree-expand-index";
import { useLazyLoadRequests } from "./use-lazy-load-requests";
import { useLatestStore } from "@plugins/primitives/plugins/latest-ref/web";
import type { TreeContextValue, TreeState } from "./use-tree-row";
import type { TreeItem } from "./types";

/**
 * Everything a tree needs to know about its rows and gestures, independent of
 * how it paints them: a renderer (the table whose rows nest) takes exactly
 * these.
 */
export type TreeModelArgs<T extends TreeItem> = {
  rows: readonly T[];
  selectedId?: string;
  /**
   * Whether a change of `selectedId` brings the row into view — expanding its
   * collapsed ancestors and scrolling to it. Default `true`. A host passes
   * `false` when the selection was made somewhere the user can already see it
   * (the same row clicked in a sibling list), so the tree keeps its place.
   */
  revealSelected?: boolean;
  rootId?: string;
  /** A row selected, with the gesture that did it (`PLAIN_GESTURE` for a programmatic select). */
  onSelect: (id: string, gesture: Gesture) => void;
  /**
   * Makes a row's select click a LINK: for an id it returns the thunk of the URL
   * a ⌘/Ctrl- or middle-click on that row opens in a new browser tab (evaluated
   * at click time), or `undefined` when that row's select is not navigation.
   * Keyboard and programmatic selects always run `onSelect`.
   */
  selectHref?: (id: string) => (() => string) | undefined;
  /**
   * Apply a whole batch of expand/collapse changes. Batch-shaped on purpose: a
   * single gesture (expand-all, the reveal-on-select ancestor walk, a drop into
   * a collapsed folder) touches N rows, and every layer below must apply them in
   * ONE update rather than N. Passing `[]` is legal and does nothing.
   */
  setExpanded: (changes: readonly ExpandChange[]) => void | Promise<void>;
  /**
   * DnD reorder/reparent. Omit for a read-only tree — the drag handle disappears.
   * The destination is positional INTENT and carries no rank: `targetId`/`zone`
   * name the drop neighbour and side, with `targetId: null` + `"after"` meaning
   * "append at the end of `dest.parentId`'s children" (what the `child` reparent
   * zone resolves to). `rows` is a projection of a shared ordering space, so the
   * rank is the server's to mint against the complete sibling set
   * (`rankAdjacentTo`) — see the rank primitive's CLAUDE.md.
   */
  onMove?: (
    id: string,
    dest: {
      parentId: string | null;
      targetId: string | null;
      zone: "before" | "after";
    },
  ) => void | Promise<void>;
  /** Create child/sibling. Omit for a read-only tree — every Add affordance disappears.
   * `afterId` is positional intent (place the new row right after that sibling). */
  onCreate?: (args: {
    parentId: string | null;
    afterId?: string;
  }) => Promise<string | null | undefined>;
  /** Content shown in the floating chip while a row is being dragged. */
  dragOverlay?: (row: T) => ReactNode;
  /**
   * The search narrowing the tree: rows whose `accessor` text contains `query`
   * (case-insensitive) stay, with every ancestor of theirs, all forced open.
   * Absent or a blank query → the whole tree.
   */
  search?: { accessor: (row: T) => string; query: string };
  /**
   * Draw every node open — the rows ARE a search's hits, narrowed by their
   * source (a live tree's server-side search), so each kept parent shows the
   * hits under it, as `search` does for its own. Like `search`, it opens the
   * painted forest only: `rows[].expanded` (the user's open set, `openKeys`)
   * is left alone, so a keystroke that changes the hits is never read as a
   * toggle. Default false.
   */
  holdOpen?: boolean;
  /**
   * Whether the data source supports creation. Defaults to true (matching the
   * historical always-on add affordance). Drives the per-row hover "+" so a
   * read-only tree shows no non-functional add button.
   */
  canCreate?: boolean;
  /**
   * Activating (body-clicking) a matching row toggles its expansion instead of
   * selecting it — the "click a folder to open it" affordance. Stateless by
   * construction: it only routes the gesture, the expand value still lives in
   * `rows[].expanded` and is written through `setExpanded`. Absent → every row
   * selects, today's behavior.
   */
  expandOnActivate?: (row: T) => boolean;
  /**
   * A single click on a matching row OPENS it (`onOpen`) instead of selecting
   * it — a file browser's folder. Keyboard moves still only select, and Enter
   * still opens. Needs `onOpen`; absent → every click selects.
   */
  openOnActivate?: (row: T) => boolean;
  /** Rows carry a multi-select checkbox (the renderer owns the provider). */
  multiSelect?: boolean;
  /**
   * Lazily-listed children (see `LazyChildren`, core). Present → a row whose
   * `hasChildren` answers true gets a chevron with no children loaded, every
   * expanded visible `unloaded` row is asked to `load`, and an open row without
   * its children yet shows a loading / failed / empty placeholder child row.
   * Absent → every row's children are already in `rows`.
   */
  lazyChildren?: LazyChildren<T>;
  /**
   * A row whose label to open for editing, asked from outside the tree (a
   * host's Rename, a row the host created itself): handed to the same
   * pending-focus signal a row `onCreate` made takes, so it opens once the
   * row is painted. Each request is a new object; `null`: nothing asked.
   */
  editLabel?: { readonly id: string } | null;
  /**
   * The OPEN gesture — double-click a row, or Enter on a focused row — distinct
   * from the single-click activation (`onSelect` / `expandOnActivate`). For a
   * file browser: click selects, double-click descends into the folder or opens
   * the file. Absent → double-click and Enter do nothing beyond the click.
   */
  onOpen?: (id: string) => void;
  /**
   * Indent guides: a hairline per ancestor level, centred in each
   * `--tree-indent` step, in `--tree-guide` — so a deep listing reads which
   * folder a row belongs to. Default false.
   */
  guides?: boolean;
};

/** The tree context the model publishes to its rows (`TreeProvider`). */
export type TreeModelContext<T extends TreeItem> = TreeContextValue<T>;

export type TreeModel<T extends TreeItem> = {
  /** `rows` narrowed to the `rootId` subtree (all of them without one). */
  scoped: readonly T[];
  /** The forest as painted: the search applied, its keepers forced open. */
  visibleTree: TreeNode<T>[];
  /** The painted lines in paint order (see `flattenVisible`). */
  flat: FlatTreeLine<T>[];
  /** The painted node ids in paint order — multi-select's range order. */
  orderedIds: string[];
  /**
   * The expanded node ids, over every row (unsearched, unscoped) — the open
   * state `flat` was flattened under. A renderer hands it to its flat list
   * (`VirtualRows` / `DataTable` `openKeys`), which folds the rows a toggle
   * reveals or hides: a toggle is exactly a flip in here.
   */
  openKeys: ReadonlySet<string>;
  /** Resolves a drop to an `onMove` (and opens a collapsed destination). */
  onDragEnd: (event: DragEndEvent) => void;
  /** The floating chip's content for the row being dragged. */
  dragChip: (id: string) => ReactNode;
  /** Create a row under `parentId` (null = a root), then select and focus it. */
  createAtRoot: (parentId: string | null) => Promise<void>;
  context: TreeModelContext<T>;
};

/**
 * The tree's state and gestures with no DOM: scoping, building, searching and
 * flattening the forest; lazy listing requests; the subtree fold index; drop
 * resolution; reveal-on-select; the pending-focus hand-off of a just-created
 * row. A renderer adds only what it paints — the rows (windowed or not), the
 * toolbar, the keyboard host — and publishes `context` to its rows
 * (`TreeProvider`).
 */
export function useTreeModel<T extends TreeItem>(
  args: TreeModelArgs<T>,
): TreeModel<T> {
  const {
    rows,
    selectedId,
    revealSelected = true,
    rootId,
    onSelect,
    selectHref,
    setExpanded,
    onMove,
    onCreate,
    dragOverlay,
    search,
    holdOpen = false,
    canCreate = true,
    expandOnActivate,
    openOnActivate,
    multiSelect = false,
    lazyChildren,
    onOpen,
    guides = false,
    editLabel = null,
  } = args;

  // The row whose name input should take focus once it appears: set by a create
  // (the row lands one live-state round-trip later), consumed by that row. Held
  // by THIS tree, never page-wide, so two mounted trees can't take each other's.
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const clearPendingFocus = useCallback(() => setPendingFocusId(null), []);
  // A host's request to edit a row's label rides the same signal, once per
  // request object (adjusted while rendering: the request is a prop change).
  const [seenEditLabel, setSeenEditLabel] = useState<typeof editLabel>(null);
  if (editLabel !== seenEditLabel) {
    setSeenEditLabel(editLabel);
    if (editLabel !== null) setPendingFocusId(editLabel.id);
  }

  // One-shot per tree mount: the first row to read it (the initially selected
  // one) gets its mount-reveal; every later reader — incidental row remounts
  // from live-state churn — reads false and stays put.
  const initialReveal = useRef(true);
  const takeInitialReveal = useCallback(() => {
    const v = initialReveal.current;
    initialReveal.current = false;
    return v;
  }, []);

  const createAtRoot = useCallback(
    async (parentId: string | null) => {
      if (!onCreate) return;
      const id = await onCreate({ parentId });
      if (!id) return;
      setPendingFocusId(id);
      onSelect(id, PLAIN_GESTURE);
    },
    [onCreate, onSelect],
  );

  // `rows[].expanded` is read straight through — no optimistic overlay. `setExpanded`
  // has exactly one sink (the DataView host's `useViewEphemeral.setExpanded`, a
  // synchronous `setState` batched into the same commit as the click) and cannot
  // fail, so a click's new value is already in `rows` on the very next render.
  // The overlay existed only for the deleted `HierarchyConfig.onToggleExpanded`,
  // an async, failable write that could leave the chevron stale until a server push.
  const scoped = useMemo(
    () => (rootId ? filterSubtree(rows, rootId) : [...rows]),
    [rows, rootId],
  );
  const tree = useMemo(() => buildTree(scoped), [scoped]);

  const searchAccessor = search?.accessor;
  const searchQuery = search?.query ?? "";
  const visibleTree = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (needle && searchAccessor)
      return filterTree<TreeNode<T>>(
        tree,
        (n) => searchAccessor(n).toLowerCase().includes(needle),
        (n) => n.children,
        (n, children) => ({ ...n, expanded: true, children }),
      );
    // The source's own search: every node kept, every node open.
    if (holdOpen)
      return filterTree<TreeNode<T>>(
        tree,
        () => true,
        (n) => n.children,
        (n, children) => ({ ...n, expanded: true, children }),
      );
    return tree;
  }, [tree, searchQuery, searchAccessor, holdOpen]);
  const searching = visibleTree !== tree;

  // The placeholder rule, bound to this render's lazy source + search state and
  // handed to every row through the context, so the recursive render and the
  // flat list below ask the same question.
  const placeholderOf = useCallback(
    (node: TreeNode<T>) => childPlaceholder(node, lazyChildren, searching),
    [lazyChildren, searching],
  );

  // Ask for the children of every open, visible, never-listed lazy node — on the
  // UNSEARCHED forest, so a search (which force-opens what it keeps) never
  // fans out listings of its own.
  useLazyLoadRequests(tree, lazyChildren);

  // The painted lines: what a windowed renderer paints, what the keyboard walks
  // and — via orderedIds — the multi-select shift-range order, so none diverge.
  //
  // Shared across renders (`createTreeSharing`): a line whose node and depth
  // are unchanged is the very object it was last render, so a renderer's
  // memoized rows redraw only the lines that changed — a search keystroke or a
  // live update rebuilds the whole forest as new objects otherwise.
  const [sharing] = useState(createTreeSharing<T>);
  const flat = useMemo(
    () =>
      sharing.lines(flattenVisible(sharing.forest(visibleTree), placeholderOf)),
    [sharing, visibleTree, placeholderOf],
  );
  const orderedIds = useMemo(() => flatNodeIds(flat), [flat]);
  // From `rows`, not the searched or scoped forest: a search (`search`, or the
  // source's own under `holdOpen`) force-opens what it keeps and a scope drops
  // rows, and neither is a toggle.
  const openKeys = useMemo(
    () => new Set(rows.filter((r) => r.expanded).map((r) => r.id)),
    [rows],
  );

  // The per-row subtree toggle every row with children renders (row-chrome).
  // Built ONCE per render from the full forest and consulted by each row, rather
  // than each row walking the rows itself — the latter is O(n) per row, i.e.
  // quadratic across a render, which is what the three hand-rolled consumer
  // copies used to pay. Keyed on `tree`, not on the searched/windowed
  // projection: a windowed tree paints only the rows on screen, and the button
  // must still answer about the whole subtree beneath it.
  const subtreeIndex = useSubtreeExpandIndex(tree);
  const toggleSubtreeExpanded = useCallback(
    (id: string) =>
      void setExpanded(
        subtreeIndex.getSubtreeChanges(id, !subtreeIndex.getAllExpanded(id)),
      ),
    [subtreeIndex, setExpanded],
  );

  // The DnD shell (DndContext, sensors, active-id lifecycle, DragOverlay chip,
  // and the windowed measuring strategy) is `RankReorderDndContext`, mounted by
  // the renderer. The tree supplies only its drop *resolution* (onDragEnd, below
  // — which keeps the `child`-zone reparent + isDescendant cycle guard) and the
  // chip content.
  const dragChip = useCallback(
    (id: string) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      return dragOverlay ? dragOverlay(row) : "Item";
    },
    [rows, dragOverlay],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!onMove) return;
      const { active, over } = event;
      if (!over) return;
      const draggedId = active.data.current?.id as string | undefined;
      const zone = over.data.current?.zone as DropZone | undefined;
      const targetId = over.data.current?.targetId as string | undefined;
      if (!draggedId || !zone || !targetId) return;
      if (draggedId === targetId) return;
      if (isDescendant(rows, draggedId, targetId)) return;
      const dest = resolveDropParent(rows, draggedId, zone, targetId);
      if (!dest) return;
      // No "already there" short-circuit: under a filtered projection that is
      // not decidable here. Two rows adjacent in `rows` can have invisible
      // siblings between them in storage, so a drop that looks like a no-op is
      // a real reposition. The server resolves the anchor against the complete
      // sibling set and is free to mint the rank the row already holds.
      //
      // A drop into a COLLAPSED destination parent would make the dragged row
      // vanish: a drag never changes `selectedRowId`, so the reveal-on-select
      // effect below never runs for a reparent. Open the destination in its own
      // batched write (idempotent — a redundant expand of an already-open folder
      // is a no-op we skip anyway).
      const destParent =
        dest.parentId === null
          ? undefined
          : rows.find((r) => r.id === dest.parentId);
      if (destParent && !destParent.expanded) {
        void setExpanded([{ id: destParent.id, expanded: true }]);
      }
      // A `child` drop reparents under the target and lands last, which as
      // neighbour intent is "after the end of the parent's child list" — i.e. a
      // null target.
      void onMove(draggedId, {
        ...dest,
        targetId: zone === "child" ? null : targetId,
        zone: zone === "child" ? "after" : zone,
      });
    },
    [rows, onMove, setExpanded],
  );

  // Auto-expand collapsed ancestors when selectedId changes so the row is visible.
  const lastRevealedId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selectedId) {
      lastRevealedId.current = undefined;
      return;
    }
    if (selectedId === lastRevealedId.current) return;
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (!byId.has(selectedId)) return;
    lastRevealedId.current = selectedId;
    // Selected where the user already sees it: leave the tree as it is.
    if (!revealSelected) return;
    // Collect the whole collapsed-ancestor chain first, then write it ONCE —
    // the walk is one gesture, not one gesture per ancestor.
    const changes: ExpandChange[] = [];
    let cur = byId.get(selectedId)!.parentId;
    while (cur) {
      const parent = byId.get(cur);
      if (!parent) break;
      if (!parent.expanded) changes.push({ id: cur, expanded: true });
      cur = parent.parentId;
    }
    if (changes.length === 0) return;
    // reveal-on-select: expands the collapsed ancestors of selectedId in one batched call so the row is visible; `setExpanded` writes the host's expand map, so it is a controlled imperative side-effect, not derivable in render; the walk needs the full rows map and is gated idempotent by the lastRevealedId ref to avoid re-running
    void setExpanded(changes);
  }, [selectedId, revealSelected, rows, setExpanded]);

  // What changes as the tree is used goes to the rows through a store, each
  // row selecting its own answers (`useTreeRow`): a new selection, a new fold
  // index or a host callback rebuilt per render re-renders only the rows whose
  // answer changed, never every row through the context.
  const treeState = useMemo<TreeState<T>>(
    () => ({
      selectedId,
      pendingFocusId,
      onSelect,
      selectHref,
      setExpanded,
      subtreeAllExpanded: subtreeIndex.getAllExpanded,
      toggleSubtreeExpanded,
      onCreate,
      expandOnActivate,
      openOnActivate,
      lazyChildren,
      onOpen,
    }),
    [
      selectedId,
      pendingFocusId,
      onSelect,
      selectHref,
      setExpanded,
      subtreeIndex,
      toggleSubtreeExpanded,
      onCreate,
      expandOnActivate,
      openOnActivate,
      lazyChildren,
      onOpen,
    ],
  );
  const state = useLatestStore(treeState);

  const canOpen = onOpen !== undefined;
  const context = useMemo<TreeModelContext<T>>(
    () => ({
      state,
      setPendingFocus: setPendingFocusId,
      clearPendingFocus,
      takeInitialReveal,
      revealSelected,
      canOpen,
      multiSelect,
      canCreate: canCreate && !!onCreate,
      canReorder: !!onMove,
      guides,
    }),
    [
      state,
      clearPendingFocus,
      takeInitialReveal,
      revealSelected,
      canOpen,
      multiSelect,
      canCreate,
      onCreate,
      onMove,
      guides,
    ],
  );

  return {
    scoped,
    visibleTree,
    flat,
    orderedIds,
    openKeys,
    onDragEnd,
    dragChip,
    createAtRoot,
    context,
  };
}

function filterSubtree<T extends TreeItem>(
  rows: readonly T[],
  rootId: string,
): T[] {
  const keep = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (r.parentId && keep.has(r.parentId) && !keep.has(r.id)) {
        keep.add(r.id);
        grew = true;
      }
    }
  }
  return rows.filter((r) => keep.has(r.id));
}
