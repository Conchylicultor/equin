import { useState } from "react";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useActionForm } from "@plugins/primitives/plugins/action-presentation/web";
import { WebsiteNavLink } from "@plugins/apps/plugins/website/plugins/shell/web";
import { track } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/web";
import { EMPTY_DRAFT, ImprovePanel, type ImproveDraft } from "./improve-panel";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const autoAwesomeIcon = symbol("auto-awesome");

/**
 * "Wish" in the shared site header — the header's one call to action, so the
 * filled pill, named like equin's own Wish button, with the agent sparkle.
 *
 * It opens a panel hung off its trailing edge (`align="end"`: the button is the
 * last item in the header, so the panel grows back over the page rather than off
 * the side of it). The pill takes the accent fill while the panel is open, which
 * `WebsiteNavLink` reads from the trigger's `aria-expanded`.
 *
 * The draft lives HERE, above the panel, because the panel unmounts when the
 * popover closes: a visitor who clicks away mid-sentence gets their words back
 * when they reopen it. Filing is the one thing that clears it.
 *
 * So does `picking`, because it is the popover that changes while the visitor
 * points at the page: it is taken out of the layout (`hidden`) so the whole page
 * can be picked. Hidden, not closed — closing would unmount the editor, and with
 * it the caret the pick is inserted at. A panel with no box is also out of the
 * picker's hit-testing, and the picker's overlay swallows the presses and the
 * Escape that would otherwise dismiss a popover.
 *
 * `display:none`, not `visibility:hidden`: visibility is inherited AND
 * transitionable, so a control in the panel that transitions it would lag the
 * panel by its transition — lingering over the page as
 * the panel hides, and still hidden for a frame when it comes back, which is
 * exactly when the pick focuses the field (a focus that then fails silently).
 * `display` does not transition.
 *
 * On a narrow screen the header runs out of room and moves items into its "⋯"
 * menu. The call to action is the one item that must stay, so it pins itself
 * at full size; the page links give way instead.
 */
export function ImproveNavItem() {
  useActionForm({ yields: "never" });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ImproveDraft>(EMPTY_DRAFT);
  const [picking, setPicking] = useState(false);
  return (
    <InlinePopover
      resetOnClose
      open={open}
      onOpenChange={(next) => {
        if (next && !open) track("improve_open");
        setOpen(next);
      }}
      align="end"
      width="2xl"
      padding="lg"
      contentClassName={picking ? cn("hidden") : undefined}
      trigger={
        <WebsiteNavLink
          label="Wish"
          emphasis="strong"
          icon={<Icon icon={autoAwesomeIcon} />}
        />
      }
    >
      <ImprovePanel
        draft={draft}
        onDraftChange={setDraft}
        picking={picking}
        onPickingChange={setPicking}
        onFiled={() => {
          setOpen(false);
          setDraft(EMPTY_DRAFT);
        }}
      />
    </InlinePopover>
  );
}
