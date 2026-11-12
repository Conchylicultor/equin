import { isAbsolute, resolve } from "node:path";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { getConfig, watchConfig } from "@plugins/config_v2/server";
import { setHostHomeResolver } from "@plugins/infra/plugins/host-fs/server";
import { HOME_DIR } from "@plugins/infra/plugins/paths/plugins/data-root-layout/core";
import { homeFolderConfig, hostHome, type HostHome } from "../../core";

/**
 * The folder `~` means: the configured stand-in home folder when there is one,
 * else the account's own `HOME_DIR` (already `resolve()`d at its one
 * definition — the spelling host-fs returns every path in, so a path the
 * browser shortens to `~/…` with it names what the server reads).
 */
function effectiveHome(): HostHome {
  const standIn = getConfig(homeFolderConfig).standIn;
  if (standIn === "") return { dir: HOME_DIR, standIn: false };
  if (!isAbsolute(standIn))
    throw new Error(
      `Stand-in home folder must be an absolute path, got "${standIn}" (config home-folder.standIn)`,
    );
  return { dir: resolve(standIn), standIn: true };
}

/**
 * host-fs expands `~` for the server and cannot read this config (config_v2's
 * machine half imports host-fs), so it takes the answer through its installer.
 * Called at boot (`onReadyBlocking`), once the config registry answers.
 */
export function installHostHomeResolver(): void {
  setHostHomeResolver(() => effectiveHome().dir);
}

// External: the truth is the process environment plus the stand-in config.
export const hostHomeServed = serveValue(hostHome, {
  source: "external",
  changes: "notified",
  loader: effectiveHome,
  whileSubscribed: (_params, notify) => {
    const unwatch = watchConfig(homeFolderConfig, () => notify());
    return () => unwatch.dispose();
  },
});
