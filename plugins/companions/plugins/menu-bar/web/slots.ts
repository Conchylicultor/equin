import {
  defineMountSlot,
  defineRenderSlot,
} from "@plugins/primitives/plugins/slot-render/web";
import type { CompanionSectionProps } from "@plugins/companions/plugins/panel/web";

export const MenuBar = {
  /** A block of the menu-bar panel, top to bottom in the slot's reorder config
   * (`config/companions/menu-bar/section.jsonc`). The panel names none: header,
   * task field, app grid, notifications switch and footer are all sections. A
   * section that has nothing to offer on this host renders `null`. */
  Section: defineRenderSlot<CompanionSectionProps>({
    docLabel: (p) => p.label,
  }),
  /** Headless work that runs while the panel page is alive — the helper keeps
   * the panel's webview loaded while hidden, so a mount here keeps running
   * (e.g. forwarding new notifications to the OS). */
  Mount: defineMountSlot({ docLabel: (p) => p.id }),
};
