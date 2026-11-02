import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { CollapsibleChevron } from "@plugins/primitives/plugins/collapsible/web";

/**
 * The named hover group every disclosure variant's reveal reads
 * (`group-hover/tree-row:`). Whatever box draws a disclosure — a tree row, a
 * nested-table row, a list row (`TreeLeading` in `Row`'s `lead`) — carries it,
 * so the chevron lights up with THAT row and no other.
 */
export const TREE_ROW_GROUP = "group/tree-row";

/**
 * A chevron that owns its own box in the row (the column disclosure, an
 * icon-less row): `--tree-chevron-w` wide — the box a leaf reserves and the
 * step the default indent is built from — faint at rest (40%), full on row
 * hover or keyboard focus. Pass it as the toggle's `className`.
 */
export const TREE_CHEVRON_CLASS =
  "w-tree-chevron h-5 shrink-0 opacity-40 group-hover/tree-row:opacity-100 focus-visible:opacity-100";

export interface TreeDisclosureToggleProps {
  isOpen: boolean;
  onToggle?: () => void;
  /** Positioning/reveal classes. The variant owns where the button sits. */
  className?: string;
}

/**
 * The expand/collapse button every tree-row disclosure variant composes.
 *
 * Owns the event plumbing, which is load-bearing and must not be re-derived per
 * variant: the click must not reach the row's `onSelect` (navigation), and the
 * pointer-down must not arm the row's whole-row drag source. A variant supplies
 * only geometry and reveal via `className`.
 */
export function TreeDisclosureToggle({
  isOpen,
  onToggle,
  className,
}: TreeDisclosureToggleProps) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label={isOpen ? "Collapse" : "Expand"}
      // eslint-disable-next-line layout/no-adhoc-layout -- centers the chevron glyph inside the caller-sized toggle box
      className={cn(
        "flex items-center justify-center rounded-md",
        // Takes the pointer even inside a click-through box (`Row`'s `lead`);
        // a variant that hides it at rest overrides this with its own
        // `pointer-events-none` (`cn` keeps the last).
        "pointer-events-auto",
        "hover:bg-background/60",
        // A ring for keyboard focus only: a mouse click focuses the button
        // too, and must not leave a ring behind on the row.
        "focus-ring",
        className,
      )}
    >
      <CollapsibleChevron open={isOpen} className="size-4" />
    </button>
  );
}
