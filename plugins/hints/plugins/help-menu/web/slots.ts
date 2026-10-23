import type { ComponentType } from "react";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";

export interface HelpMenuEntryContribution {
  /** The entry's name, for docs and the layout editor. */
  label: string;
  /**
   * One `ControlPanel.Row` (leading `icon`, `onSelect`). Call
   * `useCloseHelpMenu()` when the entry's action should close the menu.
   */
  component: ComponentType;
}

export const HelpMenu = {
  /**
   * An entry of the ? "Getting started" menu, in the slot's authored order
   * (`config/hints/help-menu/entry.jsonc`).
   */
  Entry: defineRenderSlot<HelpMenuEntryContribution>({
    docLabel: (p) => p.label,
  }),
};
