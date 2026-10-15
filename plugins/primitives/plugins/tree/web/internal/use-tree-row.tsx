import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import {
  useDroppable,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { useRankReorderItem } from "@plugins/primitives/plugins/rank-reorder/web";
import { useRevealOnActive } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import type {
  ChildPlaceholder,
  ExpandChange,
  LazyChildren,
  TreeNode,
} from "../../core";
import type { TreeItem } from "./types";

export type TreeListContextValue<T extends TreeItem> = {
  rows: readonly T[];
  selectedId: string | undefined;
  pendingFocusId: string | null;
  /** Focus this row's name input once it appears (e.g. right after a create). */
  setPendingFocus: (id: string) => void;
  clearPendingFocus: () => void;
  onSelect: (id: string) => void;
  /** See `TreeListProps.selectHref`. */
  selectHref?: (id: string) => (() => string) | undefined;
  /** Batched expand write (see `TreeListProps.setExpanded`) — a single-row
   *  toggle wraps itself in a 1-element array. */
  setExpanded: (changes: readonly ExpandChange[]) => void | Promise<void>;
  /**
   * Is every expandable node in this row's subtree (the row itself included)
   * open? Answered from an index `TreeList` builds once per render — a leaf is
   * vacuously "all expanded", and an unknown id answers `true`.
   */
  subtreeAllExpanded: (id: string) => boolean;
  /** Fold or unfold this row's whole subtree in ONE batched `setExpanded`. */
  toggleSubtreeExpanded: (id: string) => void;
  /** Omitted for a read-only tree — `canCreate` is then false and Add disappears. */
  onCreate?: (args: {
    parentId: string | null;
    afterId?: string;
  }) => Promise<string | null | undefined>;
  Row: (props: { node: TreeNode<T>; depth: number }) => ReactNode;
  /**
   * One-shot per TreeList instance: returns `true` the first time it is called
   * (the tree's initial mount) and `false` forever after. Drives the row's
   * mount-time reveal so a deep-linked selection below the fold is scrolled into
   * view exactly once, while incidental row REmounts stay inert.
   */
  takeInitialReveal: () => boolean;
  /** Whether the selected row scrolls itself into view (`TreeListProps.revealSelected`). */
  revealSelected: boolean;
  /** Activating (body-clicking) a matching row toggles its expansion instead of
   *  selecting it (see `TreeListProps.expandOnActivate`). Absent → every row
   *  selects, today's behavior. */
  expandOnActivate?: (row: T) => boolean;
  /** A single click on a matching row OPENS it (`onOpen`) instead of selecting
   *  it (see `TreeListProps.openOnActivate`). */
  openOnActivate?: (row: T) => boolean;
  /** Lazily-listed children (see `TreeListProps.lazyChildren`). */
  lazyChildren?: LazyChildren<T>;
  /** The placeholder child row an open node shows in place of children it does
   *  not have yet, or `null` (see `childPlaceholder`). Bound by `TreeList` to its
   *  lazy source and search state, so every row asks the same question. */
  childPlaceholder: (node: TreeNode<T>) => ChildPlaceholder | null;
  /** The open gesture (double-click / Enter); see `TreeListProps.onOpen`. */
  onOpen?: (id: string) => void;
  /** True when the tree is in multi-select mode → RowChrome renders a checkbox. */
  multiSelect: boolean;
  /** True when `onCreate` is wired → RowChrome renders root + per-node Add. */
  canCreate: boolean;
  /** True when `onMove` is wired → RowChrome renders the drag handle. */
  canReorder: boolean;
  /** Draw indent guides on every row (see `TreeListProps.guides`). */
  guides: boolean;
};

// The context is invariant in T at the React level; we cast through `unknown`
// at the boundary so each consumer sees its own concrete row type.
const TreeListContext = createContext<unknown>(null);

export function TreeListProvider<T extends TreeItem>({
  value,
  children,
}: {
  value: TreeListContextValue<T>;
  children: ReactNode;
}) {
  return (
    <TreeListContext.Provider value={value}>
      {children}
    </TreeListContext.Provider>
  );
}

/**
 * Non-throwing read of the tree context: `null` outside a `<TreeList>`. The
 * primitive form — a component that may be rendered by a NON-tree surface (a
 * per-item action contributed to every view of a DataView, say) can only ask
 * "am I inside a tree?" if asking is legal outside one.
 */
export function useOptionalTreeListContext<
  T extends TreeItem = TreeItem,
>(): TreeListContextValue<T> | null {
  const ctx = useContext(TreeListContext);
  return ctx === null ? null : (ctx as TreeListContextValue<T>);
}

export function useTreeListContext<
  T extends TreeItem = TreeItem,
>(): TreeListContextValue<T> {
  const ctx = useOptionalTreeListContext<T>();
  if (!ctx) {
    throw new Error("useTreeListContext must be used inside <TreeList>");
  }
  return ctx;
}

/** Stable element-type wrapper for one tree row. Its identity is constant, so a
 *  row reconciles in place across renders for a stable key — an unstable `Row`
 *  prop can no longer cause the whole row subtree to remount on background
 *  live-state churn. Invokes the current `ctx.Row` as a function (not `<Row/>`),
 *  so the returned row body (a stable module type) is the reconciliation unit;
 *  per-node hook isolation is preserved because each TreeRowSlot is keyed. */
export function TreeRowSlot<T extends TreeItem>({
  node,
  depth,
}: {
  node: TreeNode<T>;
  depth: number;
}): ReactNode {
  // Lowercase local so the React Compiler / eslint capitalized-call heuristics
  // don't treat this call as a component invocation.
  const render = useTreeListContext<T>().Row;
  return <>{render({ node, depth })}</>;
}

export type RowControls = {
  isSelected: boolean;
  isDragging: boolean;
  isOpen: boolean;
  /** The row offers a chevron: it has children loaded, or a lazy source says it
   *  may have some (`LazyChildren.hasChildren`). */
  hasChildren: boolean;
  isOverChild: boolean;
  isOverBefore: boolean;
  isOverAfter: boolean;
  shouldAutoFocus: boolean;
  consumeAutoFocus: () => void;
  select: () => void;
  /** The URL a ⌘/middle-click on the row opens; absent → the row is no link. */
  selectHref?: () => string;
  /** The open gesture for this row (double-click / Enter), or `undefined` when
   *  the tree has none — so the row can tell whether to listen at all. */
  open: (() => void) | undefined;
  /** A single click opens this row instead of selecting it (`openOnActivate`). */
  clickOpens: boolean;
  toggleExpanded: () => void;
  /** Is this row's whole subtree open? Drives the fold/unfold icon's direction. */
  subtreeAllExpanded: boolean;
  /** Fold or unfold everything under this row, in one batched write. */
  toggleSubtreeExpanded: () => void;
  addChild: () => Promise<void>;
  addBelow: () => Promise<void>;
  /**
   * The whole row is the drag source (Notion-style: no separate grip handle).
   * RowChrome merges `ref` with `childRef` onto the row element and spreads
   * `attributes`/`listeners` onto it.
   */
  dragSource: {
    ref: (el: HTMLElement | null) => void;
    attributes: DraggableAttributes;
    listeners: DraggableSyntheticListeners;
  };
  beforeRef: (el: HTMLElement | null) => void;
  afterRef: (el: HTMLElement | null) => void;
  childRef: (el: HTMLElement | null) => void;
};

// Published by `RowChrome` around the row it paints, so anything rendered INTO
// that row (a per-item action, say) can reach the row's own controls without
// being handed the node. Not generic in `T`: `RowControls` carries no row data,
// only the node's own affordances, so no consumer needs the row type.
const RowControlsContext = createContext<RowControls | null>(null);

export function RowControlsProvider({
  value,
  children,
}: {
  value: RowControls;
  children: ReactNode;
}) {
  return (
    <RowControlsContext.Provider value={value}>
      {children}
    </RowControlsContext.Provider>
  );
}

/**
 * Non-throwing read of the enclosing tree row's controls: `null` outside a tree
 * row. Same rule as `useOptionalTreeListContext` — a per-item action contributed
 * to a DataView renders in EVERY view (list / table / gallery / tree), so a
 * row-control consumer can only ask "am I inside a tree row?" if asking is legal
 * outside one. Such an action should `return null` when the controls are absent.
 */
export function useOptionalRowControls(): RowControls | null {
  return useContext(RowControlsContext);
}

export function useTreeRow<T extends TreeItem>(node: TreeNode<T>): RowControls {
  const ctx = useTreeListContext<T>();
  const isOpen = node.expanded;
  const hasChildren =
    node.children.length > 0 || (ctx.lazyChildren?.hasChildren(node) ?? false);
  const isSelected = ctx.selectedId === node.id;
  const shouldAutoFocus = ctx.pendingFocusId === node.id;

  // The drag source + before/after sibling zones come from the shared
  // rank-reorder primitive (same `{ id, rank }` / `{ zone, targetId }` data
  // contract the tree's onDragEnd reads). The `child` (reparent) zone stays
  // tree-local — only the tree has a hierarchy to nest into.
  const {
    dragSource,
    isDragging,
    beforeRef: setBeforeRef,
    afterRef: setAfterRef,
    isOverBefore,
    isOverAfter,
  } = useRankReorderItem(node.id, node.rank);
  const { isOver: isOverChild, setNodeRef: setChildRef } = useDroppable({
    id: `child:${node.id}`,
    data: { zone: "child" as const, targetId: node.id },
  });

  // Reveal the row on a false→true selection transition only — never on a
  // remount that happens to be already-selected (background live-state churn).
  // The one legitimate mount-reveal (a tree first appearing with a deep-linked
  // selection below the fold) is preserved via the per-instance one-shot.
  const setRevealRef = useRevealOnActive(isSelected && ctx.revealSelected, {
    revealOnMount: ctx.takeInitialReveal,
  });
  const wrappedChildRef = useCallback(
    (el: HTMLElement | null) => {
      setRevealRef(el);
      setChildRef(el);
    },
    [setRevealRef, setChildRef],
  );

  const toggleExpanded = useCallback(
    () => void ctx.setExpanded([{ id: node.id, expanded: !isOpen }]),
    [ctx, node.id, isOpen],
  );
  // The `expandOnActivate` branch lives HERE, not at the `onSelect` seam, and
  // that placement is load-bearing: `ctx.onSelect` is also called
  // PROGRAMMATICALLY — by `createAtRoot` (tree-list.tsx), by `addChild` /
  // `addBelow` below, and by the reveal path — and every one of those must keep
  // navigating to the row it just created or revealed. Only a real body click
  // routes through `select`, so only `select` may divert the gesture to a toggle.
  const select = useCallback(() => {
    if (ctx.expandOnActivate?.(node)) {
      toggleExpanded();
      return;
    }
    ctx.onSelect(node.id);
  }, [ctx, node, toggleExpanded]);
  // A row whose click toggles expansion is not navigating, so it is no link.
  // Presence is read now; the URL is resolved again at click time, so the thunk
  // keeps one identity across renders (this object is a context value).
  const isLink =
    !ctx.expandOnActivate?.(node) && ctx.selectHref?.(node.id) !== undefined;
  const resolveHref = ctx.selectHref;
  const selectHref = useMemo(
    () =>
      isLink && resolveHref
        ? () => {
            const href = resolveHref(node.id);
            if (!href)
              throw new Error(`tree row ${node.id} is no longer a link`);
            return href();
          }
        : undefined,
    [isLink, resolveHref, node.id],
  );
  const consumeAutoFocus = useCallback(() => ctx.clearPendingFocus(), [ctx]);
  // Distinct from `select`: no `expandOnActivate` diversion. Opening a folder IS
  // what a double-click on it asks for, whatever a single click does there.
  const onOpen = ctx.onOpen;
  const open = useMemo(
    () => (onOpen ? () => onOpen(node.id) : undefined),
    [onOpen, node.id],
  );
  const clickOpens = !!onOpen && !!ctx.openOnActivate?.(node);

  // Resolved for THIS node, so a row's fold affordance needs nothing but its own
  // controls. The read is a map lookup into the index `TreeList` built for the
  // whole forest this render; the walk that produces the write happens on click.
  const subtreeAllExpanded = ctx.subtreeAllExpanded(node.id);
  const toggleSubtreeExpanded = useCallback(
    () => ctx.toggleSubtreeExpanded(node.id),
    [ctx, node.id],
  );

  const addChild = useCallback(async () => {
    const create = ctx.onCreate;
    if (!create) return;
    const id = await create({ parentId: node.id });
    if (!id) return;
    // Reveal the new child by expanding THIS row directly, rather than leaning on
    // the reveal-on-select effect: `onSelect` is a no-op until the created row
    // lands in `rows` (a live-state round-trip), so on a collapsed folder the
    // child would be created invisibly. Expanding the parent needs no round-trip.
    await ctx.setExpanded([{ id: node.id, expanded: true }]);
    ctx.setPendingFocus(id);
    ctx.onSelect(id);
  }, [ctx, node.id]);

  // Positional intent only. `ctx.rows` may be a *filtered projection* of a
  // shared ordering space (the pages sidebar sees only `type='page'` rows of the
  // `page_blocks` forest), so a rank minted here over the visible siblings can
  // collide with an invisible one. The consumer's endpoint resolves `afterId`
  // against the complete sibling set.
  const addBelow = useCallback(async () => {
    const create = ctx.onCreate;
    if (!create) return;
    const id = await create({ parentId: node.parentId, afterId: node.id });
    if (!id) return;
    ctx.setPendingFocus(id);
    ctx.onSelect(id);
  }, [ctx, node.id, node.parentId]);

  // Memoized, not a fresh literal per render: `RowChrome` publishes this object
  // as the `RowControlsContext` value, and a context value that churns every
  // render re-renders every consumer inside the row on unrelated tree churn.
  // Every member below is already stable on its own (primitives, `useCallback`
  // handlers, dnd-kit's memoized refs), so the identity now changes only when
  // the row genuinely changes.
  return useMemo(
    () => ({
      isSelected,
      isDragging,
      isOpen,
      hasChildren,
      isOverChild,
      isOverBefore,
      isOverAfter,
      shouldAutoFocus,
      consumeAutoFocus,
      select,
      selectHref,
      open,
      clickOpens,
      toggleExpanded,
      subtreeAllExpanded,
      toggleSubtreeExpanded,
      addChild,
      addBelow,
      dragSource,
      beforeRef: setBeforeRef,
      afterRef: setAfterRef,
      childRef: wrappedChildRef,
    }),
    [
      isSelected,
      isDragging,
      isOpen,
      hasChildren,
      isOverChild,
      isOverBefore,
      isOverAfter,
      shouldAutoFocus,
      consumeAutoFocus,
      select,
      selectHref,
      open,
      clickOpens,
      toggleExpanded,
      subtreeAllExpanded,
      toggleSubtreeExpanded,
      addChild,
      addBelow,
      dragSource,
      setBeforeRef,
      setAfterRef,
      wrappedChildRef,
    ],
  );
}
