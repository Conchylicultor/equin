import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { getAppCatalog } from "../core";
import { handleAppCatalog } from "./internal/catalog";

export default {
  description:
    "The installable-app catalog the native helper installs from: GET /api/menu-bar/apps lists every listed app with its name, base path, icon PNG paths (each iconset size) and a fingerprint (id, name, base path, icon picture). The helper (menu-bar/rust) holds the device power — writing the launcher shims into ~/Applications or ~/.local/share/applications and pinning them to the Dock / GNOME dash; this side never touches the device.",
  httpRoutes: {
    [getAppCatalog.route]: handleAppCatalog,
  },
} satisfies MachinePluginDefinition;
