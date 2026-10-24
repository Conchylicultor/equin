import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { defineFileWatcher } from "@plugins/infra/plugins/file-watcher/server";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import {
  menuBarCapabilities,
  menuBarInstalled,
  menuBarPinned,
  menuBarPinRequests,
} from "../../core";
import { pinRequests } from "./pin-requests";
import { machineCapabilities, machineShimHost } from "./machine-host";
import { shimDir } from "./shim-files";
import { readInstalledAppIds, readPinnedAppIds } from "./shim-host";

/**
 * Hears the shim directory (`~/Applications` on macOS,
 * `~/.local/share/applications` on Linux) — its own entries only — so a shim
 * deleted or added outside the panel (Finder, a package manager) moves the
 * installed set.
 */
export const shimDirWatcher = defineFileWatcher({
  name: "menu-bar.shim-dir",
  description:
    "Watches the installed-app shim folder (~/Applications or ~/.local/share/applications) so the menu-bar panel's installed set follows shims added or removed outside it.",
  depth: "children",
  debounceMs: 200,
});

export const installedServed = serveValue(menuBarInstalled, {
  source: "external",
  changes: "notified",
  loader: () => {
    const host = machineShimHost();
    return { appIds: host === null ? [] : readInstalledAppIds(host) };
  },
  whileSubscribed: async (_params, notify) => {
    const host = machineShimHost();
    if (host === null) return () => {};
    const dir = shimDir(host.platform, host.roots);
    // A folder that is not there yet holds no shim; main's shim sync creates
    // it and notifies this value itself, and the next subscription watches
    // it. (Watching its parent instead would hear the whole home.)
    if (!existsSync(dir)) return () => {};
    const w = await shimDirWatcher.start({ dirs: [dir], onChange: notify });
    return () => {
      void w.stop();
    };
  },
});

/**
 * Where the Dock / GNOME dash keeps its pinned set on disk: the Dock's
 * preferences file (written by cfprefsd on every Dock change, ours or the
 * user's), dconf's user database (every `gsettings set`).
 */
function pinStore(platform: "macos" | "linux"): { dir: string; file: string } {
  return platform === "macos"
    ? {
        dir: join(HOME_DIR, "Library", "Preferences"),
        file: "com.apple.dock.plist",
      }
    : { dir: join(HOME_DIR, ".config", "dconf"), file: "user" };
}

/**
 * Hears the Dock's preferences / dconf's database (filtered to that one
 * file), so an app the user drags out of the Dock offers its pin again.
 */
export const pinStoreWatcher = defineFileWatcher({
  name: "menu-bar.pin-store",
  description:
    "Watches the Dock's preferences (macOS) or dconf's user database (Linux) so the menu-bar panel's pinned set follows apps pinned or removed in the Dock / dash itself.",
  depth: "children",
  debounceMs: 300,
});

export const pinnedServed = serveValue(menuBarPinned, {
  source: "external",
  changes: "notified",
  loader: async () => {
    const caps = await machineCapabilities();
    const host = machineShimHost();
    if (!caps.pin || host === null) return { appIds: [] };
    return { appIds: await readPinnedAppIds(host) };
  },
  whileSubscribed: async (_params, notify) => {
    const caps = await machineCapabilities();
    const host = machineShimHost();
    if (!caps.pin || host === null) return () => {};
    const store = pinStore(host.platform);
    if (!existsSync(store.dir)) return () => {};
    const w = await pinStoreWatcher.start({
      dirs: [store.dir],
      onChange: (events) => {
        if (events.some((e) => basename(e.path) === store.file)) notify();
      },
    });
    return () => {
      void w.stop();
    };
  },
});

export const pinRequestsServed = serveValue(menuBarPinRequests, {
  source: "external",
  changes: "notified",
  loader: () => ({ requests: pinRequests.list() }),
});
pinRequests.onChange(() => pinRequestsServed.notify());

export const capabilitiesServed = serveValue(menuBarCapabilities, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "the OS and its desktop shell do not change while the backend runs (probed once per process)",
    },
  },
  loader: () => machineCapabilities(),
});
