import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useCallback, type ReactNode } from "react";
import { SelectionCheckbox } from "@plugins/primitives/plugins/multi-select/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import type { TreeNode } from "../../core";
import type { TreeItem } from "./types";
import {
  RowControlsProvider,
  TreeRowSlot,
  useTreeListContext,
  useTreeRow,
  type RowControls,
} from "./use-tree-row";
import { TreeRowChrome } from "./tree-row-chrome";
import { TreeChildPlaceholder } from "./tree-child-placeholder";
import { TreeDropZones } from "./tree-drop-zones";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");
const moreHorizIcon = symbol("more-horiz");
const unfoldLessIcon = symbol("unfold-less");
const unfoldMoreIcon = symbol("unfold-more");

export type RowMenuItem = {
  icon?: IconRef;
  label: string;
  onClick: () => void;
};

export type RowChromeMenuHelpers = Pick<RowControls, "addBelow" | "addChild">;

export type RowChromeProps<T extends TreeItem> = {
  node: TreeNode<T>;
  depth: number;
  children: ReactNode;
  actions?: ReactNode;
  /**
   * Optional row icon merged into the chevron slot (Notion style: icon at rest,
   * chevron on hover). Forwarded to `TreeRowChrome.icon`.
   */
  icon?: ReactNode;
  menu?: RowMenuItem[] | ((helpers: RowChromeMenuHelpers) => RowMenuItem[]);
  /**
   * Optional full-row accent/background layer (e.g. a translucent membership
   * wash). RowChrome owns the positioning: the node is rendered into a
   * primitive-owned `pointer-events-none absolute inset-0` layer painted OVER
   * the row, so a translucent overlay composes with the hover/selected
   * backgrounds. The sanctioned home for a full-row wash — replaces the old
   * trick of rendering an `absolute inset-0` element inside `trailing`/`actions`
   * and relying on RowChrome's internal `relative` wrapper.
   */
  accent?: ReactNode;
  /**
   * The row's key in a DataView's rows, stamped as `data-row-key` (forwarded
   * to `TreeRowChrome.rowKey`) — the marker a DataView measures the rows it
   * has on screen by.
   */
  rowKey?: string;
  className?: string;
};

export function RowChrome<T extends TreeItem>(props: RowChromeProps<T>) {
  const {
    node,
    depth,
    children,
    actions,
    icon,
    menu,
    accent,
    rowKey,
    className,
  } = props;
  const controls = useTreeRow(node);
  const {
    addBelow,
    addChild: addChildAction,
    childRef,
    dragSource,
    hasChildren,
    isOpen,
    isSelected,
    toggleExpanded,
    select,
    selectHref,
    isDragging,
    isOverChild,
    beforeRef,
    afterRef,
    isOverBefore,
    isOverAfter,
    subtreeAllExpanded,
    toggleSubtreeExpanded,
    open,
    clickOpens,
  } = controls;
  const {
    ref: dragRef,
    attributes: dragAttributes,
    listeners: dragListeners,
  } = dragSource;
  const ctx = useTreeListContext<T>();
  // What this open node shows in place of children it does not have yet (a lazy
  // listing in flight, failed, or empty). The windowed list paints the same row
  // from the same rule, as an item of its own.
  const placeholder = isOpen ? ctx.childPlaceholder(node) : null;

  const menuItems =
    typeof menu === "function"
      ? menu({ addBelow, addChild: addChildAction })
      : menu;

  // The whole row is the drag source (Notion-style: no grip handle). Merge the
  // draggable ref with the child-drop ref onto the single row element — but only
  // when the tree can reorder, so a read-only tree's rows aren't draggable at all
  // (no inert pickup, matching its missing `onMove`).
  const canReorder = ctx.canReorder;
  const rowRef = useCallback(
    (el: HTMLDivElement | null) => {
      childRef(el);
      if (canReorder) dragRef(el);
    },
    [childRef, dragRef, canReorder],
  );

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
  const addChild = ctx.canCreate ? (
    <IconButton
      icon={addIcon}
      label="Add child"
      variant="ghost"
      onClick={() => addChildAction()}
    />
  ) : null;

  // Fold/unfold everything under this row — tree chrome, not a domain action, so
  // it is rendered unconditionally on every tree (gated only on `hasChildren`)
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
    node.children.length > 0 ? (
      <IconButton
        icon={subtreeAllExpanded ? unfoldLessIcon : unfoldMoreIcon}
        label={subtreeAllExpanded ? "Collapse subtree" : "Expand subtree"}
        variant="ghost"
        onClick={toggleSubtreeExpanded}
      />
    ) : null;

  // Consumer `actions` first, then the tree's own chrome. Within that chrome the
  // fold goes ahead of `⋯` and `+`, which keeps those two exactly where they sit
  // on every tree today: a row that gains the fold grows a button to their left
  // instead of shifting the two the user already aims at.
  const trailing =
    actions || subtreeToggle || moreMenu || addChild ? (
      <>
        {actions}
        {subtreeToggle}
        {moreMenu}
        {addChild}
      </>
    ) : undefined;

  return (
    <div>
      {/* Scoped to THIS row's own chrome — the child recursion below stays
          outside, so a descendant row never reads its parent's controls before
          mounting its own provider. */}
      <RowControlsProvider value={controls}>
        <div className="relative">
          <TreeRowChrome
            rowId={node.id}
            rowKey={rowKey}
            depth={depth}
            hasChildren={hasChildren}
            isOpen={isOpen}
            selected={isSelected}
            onToggle={toggleExpanded}
            onSelect={select}
            selectHref={selectHref}
            onOpen={open}
            clickOpens={clickOpens}
            guides={ctx.guides}
            rowRef={rowRef}
            dragAttributes={canReorder ? dragAttributes : undefined}
            dragListeners={canReorder ? dragListeners : undefined}
            className={cn(
              isDragging && "opacity-40",
              // The drop tint co-publishes `--scrim` for the same reason the
              // row's hover/selected tints do: it is what the pinned action
              // cluster's mask paints, so it must be the colour actually on
              // screen while a drag hovers this row.
              isOverChild &&
                "bg-accent ring-primary/40 ring-1 [--scrim:var(--accent)]",
              className,
            )}
            actions={trailing}
            icon={icon}
            leading={
              ctx.multiSelect ? (
                // The checkbox self-hides when inactive via a BARE
                // `group-hover:opacity-100`, which never fires under the row's
                // NAMED `group/tree-row`. Pass the named-group reveal variant so
                // it shows on row hover (and stays visible while selection is
                // active, where the checkbox carries no opacity-0).
                <SelectionCheckbox
                  id={node.id}
                  className="group-hover/tree-row:opacity-100"
                />
              ) : undefined
            }
          >
            {children}
          </TreeRowChrome>
          {accent != null && (
            // eslint-disable-next-line layout/no-adhoc-layout -- full-bleed accent wash painted over the row; a standalone sibling layer (Overlay wraps content, not applicable here)
            <div aria-hidden className="pointer-events-none absolute inset-0">
              {accent}
            </div>
          )}
          <TreeDropZones
            beforeRef={beforeRef}
            afterRef={afterRef}
            isOverBefore={isOverBefore}
            isOverAfter={isOverAfter}
          />
        </div>
      </RowControlsProvider>
      {/* In windowed mode the flat list already contains every visible descendant in paint order, so recursing here would double-render. */}
      {!ctx.windowed && isOpen && (
        <div>
          {node.children.map((child) => (
            <TreeRowSlot
              key={child.id}
              node={child as TreeNode<T>}
              depth={depth + 1}
            />
          ))}
          {placeholder && (
            <TreeChildPlaceholder
              placeholder={placeholder}
              depth={depth + 1}
              guides={ctx.guides}
            />
          )}
        </div>
      )}
    </div>
  );
}
