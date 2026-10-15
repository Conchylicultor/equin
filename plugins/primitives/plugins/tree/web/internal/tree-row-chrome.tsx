import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ReactNode, Ref } from "react";
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  RowActions,
  rowActionsAnchor,
} from "@plugins/primitives/plugins/row-actions/web";
import { TreeLeading } from "./tree-leading";
import { treeRowGestures } from "./tree-row-gestures";
import { treeRowIndentStyle } from "./tree-indent";

export type TreeRowChromeProps = {
  /**
   * The node's id, stamped as `data-tree-id` on the row element so the tree's
   * keyboard navigation can find (and focus) the row a key moves to.
   */
  rowId?: string;
  /**
   * The row's key in a DataView's rows, stamped as `data-row-key` — the
   * marker every DataView row carries, by which it measures the rows it has
   * on screen (a list drawn in tree chrome is still a list).
   */
  rowKey?: string;
  depth: number;
  hasChildren: boolean;
  isOpen: boolean;
  selected?: boolean;
  /** Chevron click. Stops propagation internally so it never triggers onSelect. */
  onToggle?: () => void;
  /** Row click. */
  onSelect?: () => void;
  /**
   * Makes the row click a LINK: ⌘/Ctrl- and middle-click open `selectHref()`
   * in a new browser tab instead of running `onSelect` (link-gesture). Absent →
   * every click selects, as before.
   */
  selectHref?: () => string;
  /**
   * The open gesture: double-click, or Enter while the row has focus. Present →
   * the row is focusable, and the second click of a double-click does not fire
   * `onSelect` again (so a click-to-toggle row is not toggled back by the very
   * gesture that opens it).
   */
  onOpen?: () => void;
  /**
   * A single click OPENS the row (`onOpen`) instead of selecting it — a file
   * browser's folder. The double-click that may follow is then not a second
   * open: the gesture already did what it asks for.
   */
  clickOpens?: boolean;
  children: ReactNode;
  actions?: ReactNode;
  /**
   * Leading control rendered between the chevron block and the label (e.g. the
   * multi-select checkbox). Hover-reveal scoping is the leading node's own
   * concern (pass it a `group-hover/tree-row` className) — this
   * slot only reserves layout space.
   */
  leading?: ReactNode;
  /**
   * Optional row icon (e.g. a page icon) merged into the chevron slot, Notion
   * style: the icon shows at rest and the expand/collapse chevron reveals on
   * row hover in the *same* box. When omitted, the chevron slot renders on its
   * own as before. Which rows get a chevron is the disclosure variant's call
   * (the default merged one: rows with children only).
   */
  icon?: ReactNode;
  /** Editable wrappers inject DnD state classes (dragging, drop-target ring). */
  className?: string;
  /** Editable wrappers attach the scroll + child-drop ref here. */
  rowRef?: Ref<HTMLDivElement>;
  /**
   * Whole-row drag source props (Notion-style: no grip handle): dnd-kit's
   * draggable `attributes`/`listeners`, spread onto the row so the entire row
   * is the drag source. A read-only row omits them.
   */
  dragAttributes?: DraggableAttributes;
  dragListeners?: DraggableSyntheticListeners;
  /**
   * Draw indent guides: one hairline per ancestor level in the row's indent
   * (`TreeGuides`). Default false — a tree opts in (`TreeModelArgs.guides`).
   */
  guides?: boolean;
};

/**
 * Pure presentational tree-row chrome: indentation, a fixed row height, and a
 * reserved chevron slot. No hooks, no context, no dnd-kit *logic* — a caller
 * that makes the row draggable passes dnd-kit's `dragAttributes` /
 * `dragListeners` in for this component to spread onto the row. The list
 * view's tree-shaped rows (`rowChrome: "tree"`) render through it, sharing the
 * tree row's height invariant with the nested table's outline rows.
 *
 * Deliberately NOT built on the generic `Row` primitive: tree rows need a
 * NAMED group (`group/tree-row`) to scope the chevron/actions hover-reveal to
 * the individual row. `Row` uses a bare `group`, which leaks the reveal when an
 * ancestor also carries a bare `group` (e.g. the shadcn sidebar wrapper) —
 * showing every row's actions at once. Hence the row/no-adhoc-row exception.
 */
export function TreeRowChrome({
  rowId,
  rowKey,
  depth,
  hasChildren,
  isOpen,
  selected,
  onToggle,
  onSelect,
  selectHref,
  onOpen,
  clickOpens = false,
  children,
  actions,
  leading,
  icon,
  className,
  rowRef,
  dragAttributes,
  dragListeners,
  guides = false,
}: TreeRowChromeProps) {
  const gestures = treeRowGestures({
    onSelect,
    selectHref,
    onOpen,
    clickOpens,
  });
  return (
    <Stack
      direction="row"
      align="center"
      gap="none"
      ref={rowRef as Ref<HTMLElement>}
      data-tree-row
      data-tree-id={rowId}
      data-row-key={rowKey}
      {...gestures}
      {...dragAttributes}
      {...dragListeners}
      // Bespoke named-group (group/tree-row) hover scoping: Row's bare-group
      // slots would leak the reveal under ancestor groups, so this row composes
      // Stack directly rather than the Row primitive. `rowActionsAnchor` adds a
      // SECOND, separate group (`group/row-actions`) plus the positioning
      // context the pinned action cluster anchors to — the chevron/disclosure
      // reveal keeps reading `group/tree-row`.
      className={cn(
        // Row height, cell gap, lead inset and per-depth indent are density
        // tokens (`treeRowH`, `treeRowGap`, `treeRowPadStart`, `treeIndent`),
        // so a theme owns a tree's rhythm.
        "group/tree-row min-h-tree-row gap-tree-row rounded-md px-xs py-xs text-body",
        // A focusable row (one with an open gesture) is walked with the arrow
        // keys, so the row the keys are on must show it.
        onOpen && "focus-ring",
        rowActionsAnchor,
        // Each tint co-publishes itself as `--scrim` — the colour the pinned
        // cluster's mask paints so the label it covers dissolves instead of
        // showing through the icons. Without it the mask paints the surface's
        // ambient `--chrome-mask`, i.e. the untinted background, and a hovered
        // row reads as a hole. Same contract as the `Row` primitive.
        // Selected is its own tier (`--selected`, default = the accent hover
        // fill), so a selected row does not hover to a different tone. Its
        // text takes `--selected-foreground` (default `currentColor`, i.e.
        // unchanged) and it publishes `--row-meta` for its secondary cells
        // (`text-row-meta`, default the muted tier they always wore).
        selected
          ? "bg-selected text-selected-foreground [--scrim:var(--selected)] [--row-meta:var(--selected-meta-foreground)]"
          : "hover:bg-accent hover:[--scrim:var(--accent)]",
        className,
      )}
      style={treeRowIndentStyle(depth)}
    >
      <TreeLeading
        depth={depth}
        hasChildren={hasChildren}
        isOpen={isOpen}
        onToggle={onToggle}
        icon={icon}
        leading={leading}
        guides={guides}
      />
      {children}
      {/* The shared cluster, not a second hand-rolled one: it reveals with
          opacity behind a right-edge `Pin mask`, so it reserves no flow width
          and its geometry — hence the anchor of any menu launched from it — is
          identical hovered or not. The bespoke reveal this replaced changed
          LAYOUT (`w-0` → `w-auto`), which slid an open menu sideways whenever
          the row lost hover. */}
      {actions && <RowActions>{actions}</RowActions>}
    </Stack>
  );
}
