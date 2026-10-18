import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type RefCallback,
} from "react";
import {
  extendTarget,
  nextRowSelection,
  treeKeyMove,
  type ExpandChange,
  type KeyboardLine,
  type LazyChildren,
  type RowSelectionGesture,
  type RowSelectionState,
} from "../../core";
import type { TreeItem } from "./types";

/**
 * Arrow-key navigation for a tree whose rows are focusable: a key on a
 * focused row moves the selection (`onSelect`, the same path a click takes) and
 * DOM focus together, or opens / closes the row. Keys pressed in a control
 * INSIDE a row (a rename field, an action button) are left alone.
 *
 * Focus follows on the next commit: the row a key moves to may not be mounted
 * yet (a windowed tree mounts it once the selection scrolls it into view), so
 * the wanted id is held and focused as soon as its element exists.
 *
 * With `rowSelection` (a Finder-style selection over the painted rows), a
 * plain move also makes the row the whole selection, Shift+↑/↓ extends the
 * range from the anchor (focus moves, `onSelect` does not run — the anchor
 * stays the primary row), ⌘/Ctrl+A selects every painted row and Escape
 * clears the set (left to propagate, so a host's own Escape still runs).
 */
export function useTreeKeyboard<T extends TreeItem>(args: {
  flatNodes: readonly KeyboardLine<T>[];
  enabled: boolean;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  setExpanded: (changes: readonly ExpandChange[]) => void | Promise<void>;
  lazyChildren: LazyChildren<T> | undefined;
  rowSelection?: {
    state: RowSelectionState;
    onChange: (next: RowSelectionState) => void;
  };
}): {
  containerRef: RefCallback<HTMLElement>;
  onKeyDown: ((e: KeyboardEvent<HTMLElement>) => void) | undefined;
} {
  const {
    flatNodes,
    enabled,
    selectedId,
    onSelect,
    setExpanded,
    lazyChildren,
    rowSelection,
  } = args;
  const container = useRef<HTMLElement | null>(null);
  const wanted = useRef<string | null>(null);
  const containerRef = useCallback<RefCallback<HTMLElement>>((el) => {
    container.current = el;
  }, []);

  const focusWanted = useCallback(() => {
    const id = wanted.current;
    const root = container.current;
    if (id === null || root === null) return;
    const el = Array.from(
      root.querySelectorAll<HTMLElement>("[data-tree-id]"),
    ).find((candidate) => candidate.dataset.treeId === id);
    if (!el) return;
    wanted.current = null;
    el.focus();
  }, []);

  // The painted rows, in paint order: what a range and select-all run over.
  const orderedIds = useMemo(
    () => flatNodes.flatMap((l) => (l.kind === "node" ? [l.node.id] : [])),
    [flatNodes],
  );
  const selectionState = rowSelection?.state;
  const onSelectionChange = rowSelection?.onChange;

  // A held focus target lands once its row is painted: the selection change and
  // the re-flattened rows are what mount it.
  useEffect(focusWanted, [focusWanted, selectedId, selectionState, flatNodes]);
  const reselect = useCallback(
    (gesture: RowSelectionGesture) => {
      if (!selectionState || !onSelectionChange) return;
      const next = nextRowSelection(selectionState, gesture, orderedIds);
      if (next !== selectionState) onSelectionChange(next);
    },
    [selectionState, onSelectionChange, orderedIds],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const row = e.target as HTMLElement;
      const id = row.dataset.treeId;
      if (id === undefined || !row.hasAttribute("data-tree-row")) return;
      if (selectionState) {
        if (e.key === "Escape") {
          if (selectionState.selected.size > 0) reselect({ kind: "clear" });
          return;
        }
        if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          reselect({ kind: "all" });
          return;
        }
        if (e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault();
          const delta = e.key === "ArrowDown" ? 1 : -1;
          const target = extendTarget(orderedIds, id, delta);
          if (target === null) return;
          reselect({ kind: "extend", from: id, delta });
          wanted.current = target;
          focusWanted();
          return;
        }
      }
      const move = treeKeyMove(e.key, id, flatNodes, lazyChildren);
      if (move.kind === "none") return;
      e.preventDefault();
      if (move.kind === "expand") {
        void setExpanded([{ id: move.id, expanded: move.expanded }]);
        return;
      }
      wanted.current = move.id;
      reselect({ kind: "click", id: move.id });
      onSelect(move.id);
      focusWanted();
    },
    [
      flatNodes,
      lazyChildren,
      setExpanded,
      onSelect,
      focusWanted,
      selectionState,
      reselect,
      orderedIds,
    ],
  );

  return { containerRef, onKeyDown: enabled ? onKeyDown : undefined };
}
