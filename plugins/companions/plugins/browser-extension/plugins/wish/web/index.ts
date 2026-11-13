import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { BrowserExtension } from "@plugins/companions/plugins/browser-extension/web";
import { ExtensionWishSection } from "./components/extension-wish";

export default {
  description:
    "The browser extension's Wish section (BrowserExtension.Section 'wish'): wish's WishField under a 'Wish' title — the task composer with its own ↑, filing one task under Wishes and confirming inline — about the tab the popup was opened on (DraftPage: that tab's URL for the Page URL toggle, no element picker).",
  contributions: [
    BrowserExtension.Section({
      id: "wish",
      label: "Wish",
      component: ExtensionWishSection,
    }),
  ],
} satisfies PluginDefinition;
