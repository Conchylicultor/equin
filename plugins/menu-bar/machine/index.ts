import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { onDepInstallSettled } from "@plugins/infra/plugins/deps/server";
import { installApp } from "../core";
import { menuBarHelper } from "../deps";
import { handleInstallApp } from "./internal/handle-install";
import { reconcileOnMain } from "./internal/install";
import {
  capabilitiesServed,
  installedServed,
  installRequestsServed,
  shimDirWatcher,
} from "./internal/values";

export default {
  description:
    "Installs equin's apps as OS apps, desktop half: POST /api/menu-bar/install/:appId (needsMachine) writes a launcher shim running the native helper's window mode on the app's main-namespace URL — macOS ~/Applications/equin <Name>.app (an APFS clone of the helper, Info.plist with EquinAppId / EquinUrl, app.icns from the app-manifest icon renderer, ad-hoc signed) pinned to the Dock, Linux ~/.local/share/applications/equin-<id>.desktop + its hicolor icon, pinned to the GNOME dash. The helper is copied from the menu-bar-helper dep into state/menu-bar first (a shim never names a deps-cache identity), and every shim is re-synced when that identity changes (on install, and on main's boot and helper builds); a helper not built yet is requested through deps and the install finishes when it lands. Serves menu-bar.installed (the shims on disk, watched), menu-bar.install-requests (pending / failed installs) and menu-bar.capabilities (install / pin for this OS and desktop).",
  register: [shimDirWatcher],
  httpRoutes: {
    [installApp.route]: handleInstallApp,
  },
  contributions: [
    ...installedServed.declare,
    ...installRequestsServed.declare,
    ...capabilitiesServed.declare,
  ],
  onReady: async () => {
    // Main owns the stable helper: its boot and each of its helper builds
    // bring every installed shim to main's helper.
    if (!isMain()) return;
    onDepInstallSettled(menuBarHelper, () => void reconcileOnMain());
    await reconcileOnMain();
  },
} satisfies MachinePluginDefinition;
