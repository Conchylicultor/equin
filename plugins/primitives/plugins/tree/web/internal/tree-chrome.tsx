import type { ReactNode } from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { ExpandChange } from "../../core";
import type { TreeItem } from "./types";
import { flatExpandAll } from "./flat-expand-all";

const addIcon = symbol("add");
const unfoldLessIcon = symbol("unfold-less");
const unfoldMoreIcon = symbol("unfold-more");

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
 * The gate is `flatExpandAll`, a **pure** function and not a hook, which is
 * what lets a section with nothing to fold answer `null` — a hook
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
 * whole-view expand-all (the DataView toolbar's), and a surface that keeps its chrome minimal by
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
