import type { ReactNode } from "react";
import type { IconRef } from "@plugins/ui/plugins/icons/core";

/**
 * The leading slot of an icon-bearing tree row: the row's identity icon plus
 * its expand/collapse affordance. A disclosure variant owns how the two are
 * arranged — merged into one box (Notion style), merged with childless rows
 * dimmed, or split into a dedicated chevron column (Finder / VS Code style).
 *
 * Owned by `tree` (the consumer) so the contract lives with the slot, and a UI
 * variant plugin can contribute without `tree` ever importing `plugins/ui/*` —
 * which it structurally cannot, since `ui/variant-region` reaches `config_v2`,
 * and `config_v2` reaches back into `tree` via the data-view tree.
 */
export interface TreeDisclosureProps {
  /** The row's identity icon. Non-null — icon-less rows never reach the slot. */
  icon: ReactNode;
  /**
   * Whether this row has children (or, lazily listed, may have some) — and so
   * whether it gets a chevron at all. A leaf never shows one.
   */
  hasChildren: boolean;
  /** Whether the row is currently expanded. */
  isOpen: boolean;
  /** Toggle expand/collapse. Undefined on rows that cannot toggle. */
  onToggle?: () => void;
}

/**
 * Where a lazily-listed node's children stand. A tree whose children are
 * fetched on demand (a host directory, a remote listing) cannot pretend an
 * unfetched node is a leaf, nor that a failed fetch is an empty one — so the
 * listing's state is a value the tree renders, never a stand-in.
 *
 * - `unloaded` — never requested. An EXPANDED, visible node in this state is
 *   asked for its children (`LazyChildren.load`) and paints as loading meanwhile.
 * - `loading` — a request is in flight; the node shows a loading placeholder row.
 * - `loaded` — the children present in `rows` are all of them (zero included).
 * - `failed` — the listing failed; the node shows the message and a Retry.
 */
export type TreeChildrenState =
  | { kind: "unloaded" }
  | { kind: "loading" }
  | { kind: "loaded" }
  | { kind: "failed"; message: string; retry: () => void };

/**
 * Lazily-listed children: the node's child rows arrive only after the tree asks
 * for them. Present on a tree whose consumer fetches per node; absent → every
 * node's children are already in `rows` (today's behaviour).
 *
 * The tree — not the consumer — decides WHEN to ask: `load(row)` fires once for
 * every expanded, visible node whose state is `unloaded`. That covers every way
 * a node comes to be open — a chevron click, expand-all, reveal-on-select, and
 * an expand map restored from storage on reload — which a "you were expanded"
 * change notification could not (a restored expansion is not a change).
 */
export interface LazyChildren<TRow> {
  /** This node may have children even though none are loaded yet — it gets a
   *  chevron. Rows with loaded children have one regardless. */
  hasChildren: (row: TRow) => boolean;
  /** Where this node's child listing stands. Only consulted for rows whose
   *  `hasChildren` is true. */
  state: (row: TRow) => TreeChildrenState;
  /** Request this node's children. Called at most once per `unloaded` spell —
   *  the tree re-asks only after the state has left `unloaded` and returned. */
  load: (row: TRow) => void;
  /**
   * The nodes that are open and visible and may have children — every one
   * whose listing the tree is drawing — each time that set changes (on mount
   * too, the restored expand map included). Optional: a source that keeps a
   * listing live (a subscription per folder) drives its liveness from it, so
   * a node collapsed, or folded away under a collapsed parent, stops costing
   * anything while the source keeps its last listing for an instant re-open.
   */
  onOpenChange?: (open: readonly TRow[]) => void;
}

/** One entry of a tree row's `⋯` menu. */
export type RowMenuItem = {
  icon?: IconRef;
  label: string;
  onClick: () => void;
};

/**
 * What a row-menu builder may call on the row it builds for: insert a sibling
 * right below it, or a child under it (each opens the row first when needed
 * and focuses what it made). Data, so a view's options type (in `core`) can
 * name it — the tree view and the nested table hand the same builder the same
 * helpers.
 */
export type RowMenuHelpers = {
  addBelow: () => Promise<void>;
  addChild: () => Promise<void>;
};
