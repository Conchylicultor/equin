import type { AppShellSidebarItem } from "@plugins/primitives/plugins/app-shell/web";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";

export const Deploy = {
  /**
   * The Deploy app's left rail: nav entries (Overview, …) and custom sections
   * (Sites, Servers), each contributed by the plugin that owns what it lists —
   * the shell names none of them.
   */
  Sidebar: defineRenderSlot<AppShellSidebarItem>({
    docLabel: (p) => p.title,
  }),
};
