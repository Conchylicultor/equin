import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { RowMenuHelpers, RowMenuItem } from "../../core";
import {
  useRowControls,
  useTreeContext,
  type RowControls,
} from "./use-tree-row";

const addIcon = symbol("add");
const moreHorizIcon = symbol("more-horiz");
const unfoldLessIcon = symbol("unfold-less");
const unfoldMoreIcon = symbol("unfold-more");

/** A row's `⋯` menu: its items, or a builder handed the row's helpers. */
export type RowMenu =
  RowMenuItem[] | ((helpers: RowMenuHelpers) => RowMenuItem[]);

export interface TreeRowActionsProps {
  /** The consumer's per-row actions, ahead of the tree's own chrome. */
  actions?: ReactNode;
  /** The row's `⋯` menu. Absent or empty → no `⋯`. */
  menu?: RowMenu;
  /** Loaded children: gates the subtree fold (see `treeRowTrailing`). */
  childCount: number;
}

/**
 * The trailing cluster of a tree row: the consumer's `actions`, then the
 * tree's own chrome — fold / unfold the subtree, the `⋯` menu, add a child.
 * `undefined` when there is nothing to show, so a host can skip its cluster
 * (an empty one would still spend its gap).
 *
 * The ONE implementation: the nested table's row decoration calls it with the
 * controls it computed (so a row with nothing to offer mounts no cluster), and
 * `TreeRowActions` with the controls the row publishes — so the two cannot
 * disagree on what a row offers or in what order.
 */
export function treeRowTrailing({
  actions,
  menu,
  childCount,
  controls,
  canCreate,
}: TreeRowActionsProps & {
  controls: RowControls;
  canCreate: boolean;
}): ReactNode | undefined {
  const menuItems =
    typeof menu === "function"
      ? menu({ addBelow: controls.addBelow, addChild: controls.addChild })
      : menu;

  // The "more" menu — formerly opened from the grip handle — now lives as a
  // hover-revealed trailing affordance, alongside the per-item actions.
  const moreMenu =
    menuItems && menuItems.length > 0 ? (
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="More actions"
          // `data-popup-open` is base-ui's open-state attribute; `data-state`
          // is Radix's and matches nothing here.
          className="size-5 rounded-md text-muted-foreground hover:bg-background/60 data-popup-open:bg-background/60"
        >
          <Center axis="both" className="size-full">
            <Icon icon={moreHorizIcon} className="size-4" />
          </Center>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end">
          {menuItems.map((item, i) => (
            <DropdownMenuItem key={i} onClick={item.onClick}>
              {item.icon ? <Icon icon={item.icon} className="size-4" /> : null}
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  // Notion-style per-row "+" — hover-revealed add-child affordance that replaces
  // the old persistent "Add" line under expanded nodes (more compact tree). The
  // surrounding actions cluster already stops row-click/drag propagation, owns
  // the hover-reveal AND declares the `xs` control size, so this button only
  // handles the create.
  const addChild = canCreate ? (
    <IconButton
      icon={addIcon}
      label="Add child"
      variant="ghost"
      onClick={() => void controls.addChild()}
    />
  ) : null;

  // Fold/unfold everything under this row — tree chrome, not a domain action, so
  // it is rendered unconditionally on every tree (gated only on children)
  // rather than opted into per app. Three consumer plugins used to each write
  // their own copy of this and contribute it as an app-level item action, which
  // is exactly why the surfaces that never wrote one — Pages' sidebar, the
  // config nav, the file trees — silently went without.
  //
  // A plain `IconButton`, not `collapsible`'s `ExpandAllButton`: the surrounding
  // cluster declares the `xs` control density its children derive their box
  // from, whereas `ExpandAllButton`'s compact variant is hand-sized for a
  // toolbar and would stand a size apart from the `⋯` and `+` beside it. No
  // `stopPropagation` either — `RowActions`' button `Stack` already stops both
  // `onClick` and `onPointerDown`, so the row's select and drag never fire.
  //
  // Gated on LOADED children, not `hasChildren`: a lazy row may have a chevron
  // before its listing arrives, and "unfold everything below" over a subtree
  // the tree has never seen is not a gesture it can keep.
  const subtreeToggle =
    childCount > 0 ? (
      <IconButton
        icon={controls.subtreeAllExpanded ? unfoldLessIcon : unfoldMoreIcon}
        label={
          controls.subtreeAllExpanded ? "Collapse subtree" : "Expand subtree"
        }
        variant="ghost"
        onClick={controls.toggleSubtreeExpanded}
      />
    ) : null;

  // Consumer `actions` first, then the tree's own chrome. Within that chrome the
  // fold goes ahead of `⋯` and `+`, which keeps those two exactly where they sit
  // on every tree today: a row that gains the fold grows a button to their left
  // instead of shifting the two the user already aims at.
  return actions || subtreeToggle || moreMenu || addChild ? (
    <>
      {actions}
      {subtreeToggle}
      {moreMenu}
      {addChild}
    </>
  ) : undefined;
}

/**
 * {@link treeRowTrailing} as a component, for a row that publishes its
 * controls (`RowControlsProvider`) instead of computing them where its cluster
 * renders — a nested table's row, whose trailing cell is drawn by `DataTable`.
 * Throws outside a tree row.
 */
export function TreeRowActions(props: TreeRowActionsProps): ReactNode {
  const controls = useRowControls();
  const { canCreate } = useTreeContext();
  return treeRowTrailing({ ...props, controls, canCreate }) ?? null;
}
