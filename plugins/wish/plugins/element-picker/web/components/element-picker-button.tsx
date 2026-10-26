import { insertIntoWishDraft } from "@plugins/wish/web";
import { serializeUiContext } from "@plugins/primitives/plugins/ui-context/core";
import { PickerButton } from "@plugins/primitives/plugins/ui-context/plugins/element-picker/web";

/**
 * The Improve pill's picker segment (`[✦ Improve | ⌖]`): pick an element, then
 * insert it into the Improve draft, opening the popover if it isn't already.
 * Identical in effect to the in-form `TaskDraftPickerButton` — one insertion,
 * added to whatever is already drafted — differing only in that this one
 * doesn't need the popover open to start. A ghost segment, like the Improve
 * button it is joined to: no fill and no outline, its icon in the bar's quiet
 * resting tone (inherited from the bar row), brightening on hover (ghost's
 * `hover:text-foreground`).
 */
export function ElementPickerButton() {
  return (
    <PickerButton
      variant="ghost"
      onPick={(meta) => insertIntoWishDraft(serializeUiContext(meta, "picked"))}
    />
  );
}
