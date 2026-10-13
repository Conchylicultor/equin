import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from "@dnd-kit/core";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { CollapsibleChevron } from "@plugins/primitives/plugins/collapsible/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { layerClasses } from "@plugins/primitives/plugins/css/plugins/layer/web";
import {
  RowActions,
  rowActionsAnchor,
} from "@plugins/primitives/plugins/row-actions/web";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import type { TreeDisclosureProps } from "../../core";
import { Tree } from "../slots";
import { TreeDisclosureToggle } from "./tree-disclosure-toggle";
import { TreeGuides } from "./tree-guides";
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
   * concern (RowChrome passes a `group-hover/tree-row` className into it) — this
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
   * Whole-row drag source props (Notion-style: no grip handle). The editable
   * RowChrome spreads dnd-kit's draggable `attributes`/`listeners` onto the row
   * so the entire row is the drag source. Read-only trees omit them.
   */
  dragAttributes?: DraggableAttributes;
  dragListeners?: DraggableSyntheticListeners;
  /**
   * Draw indent guides: one hairline per ancestor level in the row's indent
   * (`TreeGuides`). Default false — a tree opts in (`TreeListProps.guides`).
   */
  guides?: boolean;
};

/**
 * The current (and default) icon-bearing disclosure, extracted verbatim from
 * the row below. Used when no `Tree.Disclosure` is contributed, so rows render
 * identically even if the tree-disclosure plugin is not loaded. The `merged`
 * variant of tree-disclosure mirrors this byte-for-byte.
 *
 * Notion-style merged slot: icon at rest, chevron on row hover, both sharing
 * one size-5 box — only on a row with children; a leaf keeps its icon. The
 * icon is purely visual (the row click navigates); the overlaid chevron button
 * owns the toggle.
 */
function DefaultMergedDisclosure({
  icon,
  hasChildren,
  isOpen,
  onToggle,
}: TreeDisclosureProps) {
  return (
    <Center as="span" axis="both" className="relative size-5">
      <Center
        as="span"
        axis="both"
        className={cn(
          hasChildren &&
            "group-hover/tree-row:opacity-0 group-hover/tree-row:pointer-events-none",
        )}
      >
        {icon}
      </Center>
      {hasChildren && (
        <TreeDisclosureToggle
          isOpen={isOpen}
          onToggle={onToggle}
          className={cn(
            // The chevron button overlays the icon slot full-bleed (icon at
            // rest, chevron on hover). It is the layer itself, so it takes the
            // class rather than a wrapping <Layer>.
            layerClasses(),
            "opacity-0 pointer-events-none group-hover/tree-row:opacity-100 group-hover/tree-row:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto",
          )}
        />
      )}
    </Center>
  );
}

/**
 * Pure presentational tree-row chrome: indentation, a fixed row height, and a
 * reserved chevron slot. No hooks, no context, no dnd-kit *logic* — the
 * editable RowChrome computes the drag source via dnd-kit and passes the
 * resulting `dragAttributes`/`dragListeners` in for this component to spread
 * onto the row (read-only trees, e.g. config nav, omit them). Both render
 * through it so every tree row in the app shares one height invariant.
 *
 * Deliberately NOT built on the generic `Row` primitive: tree rows need a
 * NAMED group (`group/tree-row`) to scope the chevron/actions hover-reveal to
 * the individual row. `Row` uses a bare `group`, which leaks the reveal when an
 * ancestor also carries a bare `group` (e.g. the shadcn sidebar wrapper) —
 * showing every row's actions at once. Hence the row/no-adhoc-row exception.
 */
/** The row the latest gesture's first click landed on (see `onDoubleClick`). */
let firstClickTarget: EventTarget | null = null;

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
  // A UI plugin can contribute the icon-bearing leading disclosure (merged /
  // dimmed-leaf / column). Exactly one is expected — its Region internally
  // dispatches to the active variant. With none, fall back to the inline
  // default merged disclosure.
  const disclosures = Tree.Disclosure.useContributions();
  const disclosure = disclosures[0];
  const disclosureProps: TreeDisclosureProps = {
    icon,
    hasChildren,
    isOpen,
    onToggle,
  };
  // A link row's select click reads its gestures (⌘-click opens the href in a
  // browser tab); the aux/mousedown halves catch the middle button.
  const selectLink =
    onSelect && selectHref
      ? linkProps({ open: onSelect, href: selectHref })
      : undefined;
  const selectClick = selectLink?.onClick ?? onSelect;
  return (
    <Stack
      direction="row"
      align="center"
      gap="none"
      ref={rowRef as Ref<HTMLElement>}
      data-tree-row
      data-tree-id={rowId}
      data-row-key={rowKey}
      onClick={
        onOpen
          ? (e: MouseEvent) => {
              // `detail` counts the clicks of one gesture; the second click of
              // a double-click belongs to `onOpen`, not to another select.
              if (e.detail > 1) return;
              firstClickTarget = e.currentTarget;
              if (clickOpens) onOpen();
              else if (selectLink) selectLink.onClick(e);
              else onSelect?.();
            }
          : selectClick
      }
      onAuxClick={selectLink?.onAuxClick}
      onMouseDown={selectLink?.onMouseDown}
      onDoubleClick={
        onOpen && !clickOpens
          ? (e: MouseEvent) => {
              // Only a double-click whose FIRST click landed on this row: when
              // that click opened something and the row under the pointer was
              // replaced in between, the second click is not this row's.
              if (e.currentTarget !== firstClickTarget) return;
              onOpen();
            }
          : undefined
      }
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={
        onOpen
          ? (e: KeyboardEvent) => {
              // Only the row's own key press — never one bubbling from a
              // control inside it (a rename input, an action button).
              if (e.key !== "Enter" || e.target !== e.currentTarget) return;
              e.preventDefault();
              onOpen();
            }
          : undefined
      }
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
      {guides && <TreeGuides depth={depth} />}
      {icon != null ? (
        // useContributions() seals the `component` field, so the disclosure
        // can't be rendered as <Disclosure/>; route it through renderIsolated
        // (which unseals and applies the error-boundary middleware).
        disclosure ? (
          renderIsolated(
            Tree.Disclosure,
            disclosure as unknown as Contribution,
            disclosureProps,
          )
        ) : (
          <DefaultMergedDisclosure {...disclosureProps} />
        )
      ) : hasChildren ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={isOpen ? "Collapse" : "Expand"}
          className={cn(
            "size-5 rounded-md",
            "hover:bg-background/60",
            "opacity-40 group-hover/tree-row:opacity-100",
          )}
        >
          <Center axis="both" className="size-full">
            <CollapsibleChevron open={isOpen} className="size-4" />
          </Center>
        </button>
      ) : (
        // A leaf: reserve the chevron's width for alignment, but render no
        // expander — a chevron exists exactly when the row has children (or a
        // lazy row may have some). Dropping onto a leaf still nests under it.
        <span className="size-5" aria-hidden />
      )}
      {leading != null && (
        <Center
          as="span"
          axis="both"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {leading}
        </Center>
      )}
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
