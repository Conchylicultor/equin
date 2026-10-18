import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const closeIcon = symbol("close");

/**
 * The hover-revealed × badge overhanging a leaf node's edit-mode placeholder
 * (the placeholder is its `group`). Shared by the leaf node types so a spacer
 * and a divider are removed the same way.
 */
export function RemoveNodeButton({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <button
      // eslint-disable-next-line layout/no-adhoc-layout -- hover-revealed × badge overhanging the placeholder corner (off-ramp pixel overhang)
      className="absolute -top-1.5 -right-1.5 z-raised flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-3xs opacity-0 pointer-events-none group-hover:opacity-80 group-hover:pointer-events-auto hover:!opacity-100 hover:pointer-events-auto transition-opacity"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onRemove();
      }}
      aria-label={label}
    >
      <Icon icon={closeIcon} className="size-2.5" />
    </button>
  );
}
