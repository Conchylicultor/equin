import { useCallback, useState } from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { hintsHelpAnchor } from "@plugins/hints/core";
import { useHintAnchor, useHintAnchorPulse } from "@plugins/hints/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { HelpMenu } from "../slots";
import { CloseHelpMenuContext } from "../internal/close-menu";

const helpIcon = symbol("help");

/**
 * The ? button on the global action bar and its "Getting started" menu — the
 * same in every app, since it is one `ActionBar.Item`. The rows are
 * `HelpMenu.Entry` contributions.
 *
 * The button is the hints engine's `hintsHelpAnchor`: every tour end pulses it
 * for a few seconds (the toast says the tour lives here), and while it pulses
 * the button wears a primary ring — and the engine holds a floating bar open.
 */
export function HelpButton() {
  const [open, setOpen] = useState(false);
  const anchorRef = useHintAnchor(hintsHelpAnchor);
  const pulsing = useHintAnchorPulse(hintsHelpAnchor);
  const close = useCallback(() => setOpen(false), []);

  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={setOpen}
      align="end"
      side="bottom"
      label="Getting started"
      trigger={
        <IconButton
          ref={anchorRef}
          icon={helpIcon}
          label="Getting started"
          variant={open ? "secondary" : "ghost"}
          className={pulsing ? "animate-pulse ring-2 ring-primary" : undefined}
        />
      }
    >
      <CloseHelpMenuContext.Provider value={close}>
        <ControlPanel.Section label="Getting started">
          <HelpMenu.Entry.Render />
        </ControlPanel.Section>
      </CloseHelpMenuContext.Provider>
    </ControlPanelPopover>
  );
}
