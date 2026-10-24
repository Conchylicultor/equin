import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { getAppIconPng } from "../core";
import { handleAppIcon } from "./internal/icon-route";

export { appIconPng, appIconSvg } from "./internal/icon-png";

export default {
  description:
    "The app icons' renderer, desktop half: GET /api/apps/:appId/icon/:file (192 / 512 / 1024 .png) — the app's glyph from the installed icon sets on its tile colour, rasterized with resvg and kept per app and size. The one renderer of an app's OS icon (installed web apps, native shims): appIconPng(app, px) at any whole pixel size for a desktop-half caller writing icon files (the menu-bar shims' iconsets), and appIconSvg(app) — the picture as text, which a shim's fingerprint hashes.",
  httpRoutes: {
    [getAppIconPng.route]: handleAppIcon,
  },
} satisfies MachinePluginDefinition;
