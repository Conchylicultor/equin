import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { CompanionSectionProps } from "@plugins/companions/plugins/panel/web";
import type { PageAction } from "../core";

export const BrowserExtension = {
  /** A block of the extension's panel, top to bottom in the slot's reorder
   * config (`config/companions/browser-extension/section.jsonc`): header,
   * Wish, page actions, footer. A section with nothing for this page renders
   * `null`. */
  Section: defineRenderSlot<CompanionSectionProps>({
    docLabel: (p) => p.label,
  }),
  /** An action offered on the pages its site matches, contributed by the app
   * that owns what it does. The panel groups the matching ones by site, one
   * section each, in this slot's order. */
  PageAction: defineRenderSlot<PageAction>({
    docLabel: (p) => `${p.site.label}: ${p.title}`,
  }),
};
