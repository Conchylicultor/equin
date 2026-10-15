import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useCallback, type ReactNode } from "react";
import { SelectionCheckbox } from "@plugins/primitives/plugins/multi-select/web";
import type {
  RowMenuHelpers,
  RowMenuItem as CoreRowMenuItem,
  TreeNode,
} from "../../core";
import type { TreeItem } from "./types";
import {
  RowControlsProvider,
  useTreeListContext,
  useTreeRow,
} from "./use-tree-row";
import { TreeRowChrome } from "./tree-row-chrome";
import { TreeDropZones } from "./tree-drop-zones";
import { treeRowTrailing, type RowMenu } from "./tree-row-actions";

export type RowMenuItem = CoreRowMenuItem;

export type RowChromeMenuHelpers = RowMenuHelpers;

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
  menu?: RowMenu;
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
    open,
    clickOpens,
  } = controls;
  const {
    ref: dragRef,
    attributes: dragAttributes,
    listeners: dragListeners,
  } = dragSource;
  const ctx = useTreeListContext<T>();

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

  const trailing = treeRowTrailing({
    actions,
    menu,
    childCount: node.children.length,
    controls,
    canCreate: ctx.canCreate,
  });

  return (
    <div>
      {/* Scoped to THIS row's own chrome: every line of the flattened tree
          mounts its own provider. */}
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
    </div>
  );
}
