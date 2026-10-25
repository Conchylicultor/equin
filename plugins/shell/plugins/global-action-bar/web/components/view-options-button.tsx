import { useState } from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { ControlPanelPopover } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { renderViewOptionForAudience } from "../internal/render-for-audience";

const settingsIcon = symbol("settings");

/**
 * The bar's single gear button. Options about how the app is SHOWN (surface
 * mode, browser fullscreen, layout editing) are set once and left alone, so
 * they share one popover instead of each taking a button in the bar. The rows
 * come from `ActionBar.ViewOption`, each shown to the audience it declares —
 * for a regular user only the Developer mode switch, kept first by order config.
 *
 * The button itself is an ordinary `ActionBar.Item` (contributed by this
 * plugin), so where it sits in the bar is the slot's order, like every other
 * action — not a fixed "always last".
 */
export function ViewOptionsButton() {
  const [open, setOpen] = useState(false);

  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={setOpen}
      align="end"
      side="bottom"
      label="View options"
      trigger={
        <IconButton
          icon={settingsIcon}
          label="View options"
          variant={open ? "secondary" : "ghost"}
        />
      }
    >
      <ActionBar.ViewOption.Render>
        {renderViewOptionForAudience}
      </ActionBar.ViewOption.Render>
    </ControlPanelPopover>
  );
}
