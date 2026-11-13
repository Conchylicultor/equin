import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { MenuBar } from "@plugins/companions/plugins/menu-bar/web";
import { MenuBarWishSection } from "./components/menu-bar-wish";

export default {
  description:
    "The menu-bar panel's Wish section (MenuBar.Section 'wish'): wish's WishField under a 'Wish' title — the task composer with its own ↑, filing one task under Wishes and confirming inline. The tray is about no page (DraftPage NO_DRAFT_PAGE: no Page URL toggle, no element picker). The field keeps its own draft text.",
  contributions: [
    MenuBar.Section({
      id: "wish",
      label: "Wish",
      component: MenuBarWishSection,
    }),
  ],
} satisfies PluginDefinition;
