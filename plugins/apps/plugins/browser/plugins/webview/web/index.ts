import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Browser } from "@plugins/apps/plugins/browser/plugins/shell/web";
import { Viewport } from "./components/viewport";
import { OpenExternal } from "./components/open-external";

export default {
  description:
    "Browser webview: the active tab's page streamed from the engine's Chromium — JPEG screencast frames drawn on a canvas, mouse / wheel / keyboard / IME / clipboard input sent back over the tab's engine socket, the page's dialogs, <select> menus, popups and downloads rendered with app primitives — with a loading bar, the start page for an empty tab, closed tabs' remote pages closed on the host, plus an open-in-system-browser chrome action.",
  contributions: [
    Browser.Viewport({ id: "viewport", component: Viewport }),
    Browser.Actions({ id: "open-external", component: OpenExternal }),
  ],
} satisfies PluginDefinition;
