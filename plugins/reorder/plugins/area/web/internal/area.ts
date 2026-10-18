import {
  createContext,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react";

// What a reorder area draws, shared by the side that applies a layout (`reorder`,
// in every bundle) and the side that edits one (`reorder.editor`,
// `reorder.edit-mode`, opt-in). A leaf: `reorder` reaches the editor's other
// consumer (`fields.reorder-tree.config`) through its own imports, so neither
// side may import the other's barrel for these.

/**
 * A top-level row of an area. `id` is BOTH the sortable id and the key passed
 * back to the writes (`drop`/`hide`). `node` is opaque, pre-rendered content.
 */
export interface ReorderItemEntry {
  kind: "item";
  id: string;
  /** Pinned non-reorderable (e.g. `excludeFromReorder`): kept out of the sortable ids. */
  excluded?: boolean;
  node: ReactNode;
}

/**
 * An opaque pre-rendered node — a leaf (spacer, divider) or a container (a
 * header box). `memberIds` is present ONLY for containers: the sortable ids of
 * the members drawn inside it (a container is not itself draggable). A leaf
 * omits it and is sortable by its own `id`.
 */
export interface ReorderNodeEntry {
  kind: "node";
  id: string;
  node: ReactNode;
  memberIds?: string[];
}

export type ReorderEntry = ReorderItemEntry | ReorderNodeEntry;

/**
 * The classes an editor's {@link ReorderItemChromeProps item chrome} dresses an
 * item box in. `null` (no chrome mounted) is the at-rest box: both levels
 * `display: contents`.
 */
export interface ReorderItemChromeClasses {
  box: (state: { isDragging: boolean }) => string;
  content: string;
}

/**
 * Mounted INSIDE an item box, ahead of its content, while the item is editable:
 * draws the edit affordances (×-badge, empty-item placeholder) and publishes the
 * classes the box and its content wrapper wear. A sibling of the content, so
 * mounting it remounts nothing.
 */
export interface ReorderItemChromeProps {
  itemKey: string;
  label: string;
  fill: boolean;
  /** A widget inside asked the chain for inline room (`GrowRelay`). */
  asked: boolean;
  /** The content wrapper — the box observes it for emptiness. */
  contentRef: RefObject<HTMLDivElement | null>;
  publish: (classes: ReorderItemChromeClasses | null) => void;
}

/** Read by what an area draws: the item boxes, the node types, the item chrome. */
export interface ReorderAreaCtxValue {
  orientation: "horizontal" | "vertical";
  /** Hide a contribution by id (its entryKey). */
  onHide: (id: string) => void;
  /** Remove a node (e.g. a spacer) by id. */
  onRemoveNode: (id: string) => void;
  /** The chrome an editable item box mounts; `null` where no editor ships. */
  ItemChrome: ComponentType<ReorderItemChromeProps> | null;
}

export const ReorderAreaContext = createContext<ReorderAreaCtxValue | null>(
  null,
);
