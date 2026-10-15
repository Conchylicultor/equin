import type { ReactNode } from "react";
import { ExpandAllButton } from "@plugins/primitives/plugins/collapsible/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { ExpandChange } from "../../core";
import type { TreeItem } from "./types";
import { flatExpandAll } from "./use-flat-expand-all";

const addIcon = symbol("add");
const unfoldLessIcon = symbol("unfold-less");
const unfoldMoreIcon = symbol("unfold-more");

export interface TreeToolbarProps {
  /** Content on the left (a filter input, a surface's own actions). */
  start?: ReactNode;
  /** The whole-tree expand-all toggle on the right; absent → none. */
  expandAll?: { allExpanded: boolean; onToggle: () => void };
}

/**
 * A tree's sticky toolbar row: `start` on the left, the expand-all toggle on
 * the right. One markup for every tree renderer that has one.
 * The caller decides whether there is one at all (it renders nothing of its
 * own when both slots are empty).
 */
export function TreeToolbar({ start, expandAll }: TreeToolbarProps): ReactNode {
  return (
    // eslint-disable-next-line spacing/no-adhoc-spacing -- mb separates the sticky toolbar from the tree rows below (no named margin utility)
    <Sticky mask className="mb-1">
      <Stack direction="row" gap="xs" align="center" justify="between">
        <Stack direction="row" gap="xs" align="center">
          {start}
        </Stack>
        <Stack direction="row" gap="xs" align="center">
          {expandAll && (
            <ExpandAllButton
              allExpanded={expandAll.allExpanded}
              onToggle={expandAll.onToggle}
            />
          )}
        </Stack>
      </Stack>
    </Sticky>
  );
}

/**
 * The root-level "Add" button under a tree's rows (a new top-level row). One
 * markup for every tree renderer.
 */
export function TreeRootAdd({
  label,
  onAdd,
}: {
  label: string;
  onAdd: () => void;
}): ReactNode {
  return (
    <Button
      variant="ghost"
      onClick={onAdd}
      // eslint-disable-next-line spacing/no-adhoc-spacing -- mt offsets the root Add button from the tree rows above (no named margin utility)
      className="text-muted-foreground mt-1 w-fit"
    >
      <Icon icon={addIcon} className="size-4" />
      {label}
    </Button>
  );
}

/**
 * The fold/unfold-this-group toggle a grouped tree hangs off its section
 * headers (`GroupedSections.headerActions`, the table's group header `action`)
 * — which wrap it in the header's hover-revealed cluster, so the button costs
 * the header nothing at rest and cannot collapse the section it sits on.
 *
 * A section-scoped fold is well-defined because a section bucket holds whole
 * subtrees: the hierarchy pipeline files every descendant under its ROOT's
 * section, so folding a group never leaves half a subtree in another one.
 *
 * The gate is `flatExpandAll`'s **pure** form, not the `useFlatExpandAll` hook,
 * which is what lets a section with nothing to fold answer `null` — a hook
 * would have to live in a child component, and a child component that renders
 * nothing still hands the header a non-null element to wrap, leaving an empty
 * cluster that spends the header's `gap` and pulls that section's count off
 * the edge its neighbours line up on.
 *
 * A plain `IconButton`, not `collapsible`'s `ExpandAllButton` — the same call
 * the tree's own per-row fold makes, for the same reason: the surrounding
 * `RowActions` declares the `xs` control density its children derive their box
 * from, whereas `ExpandAllButton`'s compact variant is hand-sized for a toolbar.
 * The two folds are one gesture at two scopes, so they read as one glyph.
 *
 * Deliberately NOT gated on a view's `expandAll` option. That option names the
 * whole-view TOOLBAR button, and a surface that keeps its chrome minimal by
 * omitting it — a narrow sidebar tree like the Pages sidebar's — is exactly
 * the surface this exists for.
 */
export function groupFoldAction<T extends TreeItem>(
  rows: readonly T[],
  setExpanded: (changes: readonly ExpandChange[]) => void,
): ReactNode {
  const state = flatExpandAll(rows);
  if (!state.hasExpandable) return null;
  const collapse = state.allExpanded;
  return (
    <IconButton
      icon={collapse ? unfoldLessIcon : unfoldMoreIcon}
      label={collapse ? "Collapse group" : "Expand group"}
      variant="ghost"
      onClick={() => setExpanded(state.changes(!collapse))}
    />
  );
}
