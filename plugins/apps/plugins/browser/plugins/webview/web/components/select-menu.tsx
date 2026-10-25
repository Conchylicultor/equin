import type { HostEvent } from "@plugins/apps/plugins/browser/plugins/engine/core";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  CursorAnchoredMenu,
  type CursorAnchor,
} from "@plugins/primitives/plugins/overlay/plugins/cursor-menu/web";

export type PageSelectEvent = Extract<HostEvent, { t: "select" }>;

/**
 * A page's native `<select>` popup, which the screencast does not show: the
 * host reports the options and the element's box, and this menu opens under
 * that box. Picking answers the value; closing without a pick answers `null`.
 */
export function SelectMenu({
  select,
  anchor,
  onPick,
}: {
  select: PageSelectEvent;
  /** Viewport coords of the `<select>`'s bottom-left corner. */
  anchor: CursorAnchor;
  onPick(value: string | null): void;
}) {
  const selected = select.options.find((o) => o.selected)?.value;
  return (
    <CursorAnchoredMenu anchor={anchor} onClose={() => onPick(null)}>
      <DropdownMenuRadioGroup
        value={selected}
        onValueChange={(value: string) => onPick(value)}
      >
        {select.options.map((o, i) => (
          <DropdownMenuRadioItem
            // Option values may repeat; the index keeps keys unique.
            key={`${i}:${o.value}`}
            value={o.value}
            disabled={o.disabled}
            closeOnClick
          >
            {o.label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </CursorAnchoredMenu>
  );
}
