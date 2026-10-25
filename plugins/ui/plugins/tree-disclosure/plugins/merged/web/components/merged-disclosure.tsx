import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { TreeDisclosureToggle } from "@plugins/primitives/plugins/tree/web";
import type { TreeDisclosureProps } from "@plugins/primitives/plugins/tree/core";

/**
 * Merged disclosure (Notion style) — the identity icon and the chevron share
 * one size-5 box: icon at rest, chevron on row hover. The box starts where the
 * column variant's chevron box would, so the default guide (half the chevron
 * box) lands on the parent's icon centre. Pages and the file explorer pin it.
 *
 * Only a row with children swaps its icon for the chevron: a leaf keeps its
 * icon under the cursor, so hovering is how you tell parents from leaves. The
 * trade-off this variant accepts is that structure is invisible at rest.
 */
export function MergedDisclosure({
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
          // eslint-disable-next-line layout/no-adhoc-layout -- chevron button overlays the icon slot full-bleed (icon at rest, chevron on hover)
          className={cn(
            "absolute inset-0",
            "opacity-0 pointer-events-none group-hover/tree-row:opacity-100 group-hover/tree-row:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto",
          )}
        />
      )}
    </Center>
  );
}
