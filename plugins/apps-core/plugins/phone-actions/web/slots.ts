import type { ComponentType } from "react";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";

/** What a sub-action's sheet is handed. */
export interface PhoneActionSheetProps {
  /** Close the sheet (the button comes back). */
  close: () => void;
}

export interface PhoneActionContribution {
  id: string;
  /** The bubble's label, and the sheet's accessible title. */
  label: string;
  /** The bubble's glyph. */
  icon: IconRef;
  /**
   * The sheet's body, drawn in a bottom sheet the button owns (its grabber,
   * its scrim, its slide). The body draws only what it is for — the app
   * grid, the wish composer.
   */
  component: ComponentType<PhoneActionSheetProps>;
}

/**
 * The phone action button's sub-actions, fanned out from it in this slot's
 * order (`config/apps-core/phone-actions/action.jsonc`): each is a labelled
 * bubble that opens its own bottom sheet. The button names no contributor.
 */
export const PhoneActions = {
  Action: defineRenderSlot<PhoneActionContribution>({
    docLabel: (p) => p.label,
  }),
};
