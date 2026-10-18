import type { ComponentType } from "react";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";

/** One layer of desktop chrome over the windows; see {@link Desktop.Overlay}. */
export interface DesktopOverlayContribution {
  /** Unique among the overlays; keys the rendered list. */
  id: string;
  /**
   * Rendered once while the desktop is active, above every window, inside the
   * desktop's theme (`app:desktop`). `tabIds` are the LIVE desktop tabs (a
   * closing window has already left), in tab order.
   */
  component: ComponentType<{ tabIds: string[] }>;
}

export const Desktop = {
  /**
   * The desktop's chrome layers — the shelf, the launcher, the overview, the
   * switcher. The windows plugin owns the desktop's foreground and mounts every
   * contribution there, so a layer is a plugin of its own and the windows
   * plugin names none of them.
   */
  Overlay: defineSlot<DesktopOverlayContribution>({
    docLabel: () => "Desktop overlay",
  }),
};
