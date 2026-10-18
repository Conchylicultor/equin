import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Desktop } from "@plugins/apps/plugins/desktop/plugins/windows/web";
import { Shelf } from "./components/shelf";

export default {
  description:
    "The desktop's bottom shelf: a centred dock with the launcher button, the pinned apps and the running ones (grouped per app, with window pips, hover thumbnails and a right-click app menu), and the tray — the pager's mini-desktops with their desktop previews, the overview button and the clock. Reserves the desktop's bottom work area and is where windows minimise to.",
  contributions: [Desktop.Overlay({ id: "shelf", component: Shelf })],
} satisfies PluginDefinition;
