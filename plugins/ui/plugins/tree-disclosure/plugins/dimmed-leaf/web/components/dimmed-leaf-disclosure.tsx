import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { TreeDisclosureToggle } from "@plugins/primitives/plugins/tree/web";
import type { TreeDisclosureProps } from "@plugins/primitives/plugins/tree/core";

/**
 * Dimmed-leaf disclosure — the merged box, with a childless row's icon
 * desaturated and dimmed so parents read as the higher-contrast rows.
 *
 * Keeps the merged variant's compactness (no extra column) and needs no hover,
 * but pays for it: the signal is a relative one (you read it by comparing rows,
 * not by looking at one), and it borrows the muted/disabled channel to mean
 * "leaf", which is not a lesser state.
 */
export function DimmedLeafDisclosure({
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
          !hasChildren && "opacity-45 saturate-50",
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
