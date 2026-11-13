import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

/**
 * The browser-extension panel, as an app of its own: the page the extension's
 * popup frames (`/home/browser-extension?embed=1`).
 *
 * Its own app for the same reason as the menu bar's (`menuBarApp`): a colour
 * scheme and a theme belong to an app, and the panel wears the companions'
 * theme (`companion`) and follows the OS (`colorMode: "system"`). Unlisted:
 * nothing inside equin launches it — the extension's popup does.
 */
export const browserExtensionApp = defineApp({
  id: "browser-extension",
  name: "Browser extension",
  basePath: "/home/browser-extension",
  icon: symbol("extension"),
  colorMode: "system",
  listed: false,
});
