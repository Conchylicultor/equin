import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { onDepInstallSettled } from "@plugins/infra/plugins/deps/server";
import { pinApp } from "../core";
import { menuBarHelper } from "../deps";
import { handlePinApp } from "./internal/handle-pin";
import { syncAllShimsOnMain } from "./internal/shims";
import {
  capabilitiesServed,
  installedServed,
  pinnedServed,
  pinRequestsServed,
  pinStoreWatcher,
  shimDirWatcher,
} from "./internal/values";

export default {
  description:
    "Makes every equin app an OS app of its own, desktop half: main keeps a launcher shim for every installable app, ahead of any click (on its boot and each helper build: missing or stale shims written — a shim's fingerprint hashes its app's name, URL and icon — and renamed or removed apps' shims removed), so a menu-bar tile always opens its app's own window. A shim runs the native helper's window mode on the app's main-namespace URL — macOS ~/Applications/equin <Name>.app (an APFS clone of the helper, Info.plist with EquinAppId / EquinUrl / EquinShimHash, app.icns from the app-manifest icon renderer at each iconset size, ad-hoc signed), Linux ~/.local/share/applications/equin-<id>.desktop + its hicolor icon. POST /api/menu-bar/pin/:appId (needsMachine) keeps one in the Dock / GNOME dash (writing its shim first when main has not); a helper not built yet is requested through deps and the pin finishes when it lands. The helper is copied from the menu-bar-helper dep into state/menu-bar first (a shim never names a deps-cache identity). Serves menu-bar.installed (the shims on disk, watched), menu-bar.pinned (the Dock / dash set, watched), menu-bar.pin-requests (pending / failed pins) and menu-bar.capabilities (install / pin for this OS and desktop).",
  register: [shimDirWatcher, pinStoreWatcher],
  httpRoutes: {
    [pinApp.route]: handlePinApp,
  },
  contributions: [
    ...installedServed.declare,
    ...pinnedServed.declare,
    ...pinRequestsServed.declare,
    ...capabilitiesServed.declare,
  ],
  onReady: async () => {
    // Main owns the stable helper and the shim set: its boot and each of its
    // helper builds bring a shim for every app to main's helper.
    if (!isMain()) return;
    onDepInstallSettled(menuBarHelper, () => void syncAllShimsOnMain());
    await syncAllShimsOnMain();
  },
} satisfies MachinePluginDefinition;
