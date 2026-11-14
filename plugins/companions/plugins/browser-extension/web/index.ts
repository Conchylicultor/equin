import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { CompanionHeader } from "@plugins/companions/plugins/panel/web";
import { browserExtensionApp } from "../core";
import { BrowserExtension as BrowserExtensionSlots } from "./slots";
import { BrowserExtensionPanel } from "./components/extension-panel";
import { ExtensionFooter } from "./components/extension-footer";
import { PageActionsSection } from "./components/page-actions";

export { BrowserExtension } from "./slots";
export { useExtensionHost, type ExtensionHost } from "./host";

export default {
  description:
    "The browser extension's panel: the browser-extension app (unlisted, colorMode system, in the companions' `companion` theme) mounted at /home/browser-extension, whose whole layout is the companions' panel over the BrowserExtension.Section slot (chromeless under ?embed=1) — the companions' header (its Companion.Status attention mirrored as a dot on the toolbar icon), the page actions, and the footer (opening equin in a new tab). useExtensionHost() reads the popup's bridge (a MessagePort accepted only from the extension's own origin): pending, absent (a plain tab — the route then says it runs inside the extension), or present with the shell's info, the tab the popup is about and its methods. BrowserExtension.PageAction is an action an app offers on the pages its site matches; the page-actions section groups the matching ones by site (one labelled section each), each a gradient tile, title and subtitle with its ⌘N, a spinner while it runs, then a check. The panel reports its height to the popup, records each open, and reloads the extension when the served shell's digest differs from its own.",
  contributions: [
    // Its own app (unlisted, following the OS scheme); the panel is its whole
    // layout (no pane, so no pane header behind it).
    Apps.App({ app: browserExtensionApp, component: BrowserExtensionPanel }),
    BrowserExtensionSlots.Section({
      id: "header",
      label: "Header",
      component: CompanionHeader,
    }),
    BrowserExtensionSlots.Section({
      id: "page-actions",
      label: "Page actions",
      component: PageActionsSection,
    }),
    BrowserExtensionSlots.Section({
      id: "footer",
      label: "Footer",
      component: ExtensionFooter,
    }),
  ],
  slots: BrowserExtensionSlots,
} satisfies PluginDefinition;
