import { existsSync } from "node:fs";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { defineFileWatcher } from "@plugins/infra/plugins/file-watcher/server";
import {
  menuBarCapabilities,
  menuBarInstalled,
  menuBarInstallRequests,
} from "../../core";
import { installRequests } from "./install-requests";
import { machineCapabilities, machineShimHost } from "./machine-host";
import { shimDir } from "./shim-files";
import { readInstalledAppIds } from "./shim-host";

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
    // A folder that is not there yet holds no shim; the install endpoint
    // creates it and notifies this value itself, and the next subscription
    // watches it. (Watching its parent instead would hear the whole home.)
    if (!existsSync(dir)) return () => {};
    const w = await shimDirWatcher.start({ dirs: [dir], onChange: notify });
    return () => {
      void w.stop();
    };
  },
});

export const installRequestsServed = serveValue(menuBarInstallRequests, {
  source: "external",
  changes: "notified",
  loader: () => ({ requests: installRequests.list() }),
});
installRequests.onChange(() => installRequestsServed.notify());

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
