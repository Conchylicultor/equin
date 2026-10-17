import type { ComponentType } from "react";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { ControlPanelWidthNeed } from "@plugins/primitives/plugins/css/plugins/control-panel/web";

export interface QuickThemeSectionContribution {
  /** Short heading rendered above the section inside the popover. */
  label: string;
  component: ComponentType;
  /** The width the section's content needs — `picker` for a swatch grid. The
   *  popover is as wide as the widest need among the sections it shows. */
  needs?: ControlPanelWidthNeed;
}

/**
 * The quick-switch popover's own section slot. It is deliberately NOT the
 * customizer pane's `ThemeCustomizer.Section`: a pane section is authored for a
 * 440px-wide scrolling pane (search-driven, full catalogs, token rows), while a
 * quick section must fit a popover a user glances at without leaving their
 * context. A contributor that wants both surfaces contributes twice, with a
 * different component each time.
 */
export const QuickTheme = {
  Section: defineRenderSlot<QuickThemeSectionContribution>({
    docLabel: (p) => p.label,
  }),
};
