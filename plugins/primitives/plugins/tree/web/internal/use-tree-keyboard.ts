import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type RefCallback,
} from "react";
import {
  treeKeyMove,
  type ExpandChange,
  type KeyboardLine,
  type LazyChildren,
} from "../../core";
import type { TreeItem } from "./types";

/**
 * Arrow-key navigation for a `TreeList` whose rows are focusable: a key on a
 * focused row moves the selection (`onSelect`, the same path a click takes) and
 * DOM focus together, or opens / closes the row. Keys pressed in a control
 * INSIDE a row (a rename field, an action button) are left alone.
 *
 * Focus follows on the next commit: the row a key moves to may not be mounted
 * yet (a windowed tree mounts it once the selection scrolls it into view), so
 * the wanted id is held and focused as soon as its element exists.
 */
export function useTreeKeyboard<T extends TreeItem>(args: {
  flatNodes: readonly KeyboardLine<T>[];
  enabled: boolean;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  setExpanded: (changes: readonly ExpandChange[]) => void | Promise<void>;
  lazyChildren: LazyChildren<T> | undefined;
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

  // A held focus target lands once its row is painted: the selection change and
  // the re-flattened rows are what mount it.
  useEffect(focusWanted, [focusWanted, selectedId, flatNodes]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const row = e.target as HTMLElement;
      const id = row.dataset.treeId;
      if (id === undefined || !row.hasAttribute("data-tree-row")) return;
      const move = treeKeyMove(e.key, id, flatNodes, lazyChildren);
      if (move.kind === "none") return;
      e.preventDefault();
      if (move.kind === "expand") {
        void setExpanded([{ id: move.id, expanded: move.expanded }]);
        return;
      }
      wanted.current = move.id;
      onSelect(move.id);
      focusWanted();
    },
    [flatNodes, lazyChildren, setExpanded, onSelect, focusWanted],
  );

  return { containerRef, onKeyDown: enabled ? onKeyDown : undefined };
}
