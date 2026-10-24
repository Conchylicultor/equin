import { declaredApps } from "@plugins/apps-core/server";
import { appIconPng } from "@plugins/apps-core/plugins/app-manifest/machine";
import { installableApp } from "@plugins/apps-core/plugins/app-manifest/core";
import {
  spawnCaptured,
  spawnExpectOk,
} from "@plugins/infra/plugins/spawn/core";
import {
  MAIN_WORKTREE_NAME,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import type { InstallCapabilities } from "../../core";
import { installCapabilities } from "./capabilities";
import {
  defaultShimRoots,
  GNOME_FAVORITES_READ_ARGV,
  type ShimApp,
} from "./shim-files";
import type { ShimHost } from "./shim-host";

/** One shim command's ceiling: `codesign` / `iconutil` / `defaults` answer in seconds. */
const COMMAND_TIMEOUT_MS = 60_000;

async function run(argv: readonly string[]): Promise<string> {
  const result = await spawnExpectOk([...argv], {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  return result.stdout;
}

/**
 * This computer as a shim host: the user's real `~/Applications` /
 * `~/.local/share`, real commands, the app-manifest icon renderer. Null on a
 * platform with no shims (the capability says so).
 */
export function machineShimHost(): ShimHost | null {
  const platform =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "linux"
        ? "linux"
        : null;
  if (platform === null) return null;
  return {
    platform,
    roots: defaultShimRoots(HOME_DIR),
    run,
    iconPng: (appId, size) => {
      const app = installableApp(declaredApps, appId);
      if (app === undefined) throw new Error(`no installable app "${appId}"`);
      return appIconPng(app, size);
    },
  };
}

/**
 * The app a shim opens, by id: an installable app on the MAIN namespace (an
 * installed app is the user's app, whichever checkout installed it). Undefined
 * for an unknown or unlisted app.
 */
export function shimApp(appId: string): ShimApp | undefined {
  const app = installableApp(declaredApps, appId);
  if (app === undefined) return undefined;
  return {
    id: app.id,
    name: app.name,
    url: namespaceUrl(MAIN_WORKTREE_NAME, app.basePath),
    namespace: MAIN_WORKTREE_NAME,
  };
}

let capabilities: Promise<InstallCapabilities> | null = null;

/** This host's install / pin capabilities, probed once per process. */
export function machineCapabilities(): Promise<InstallCapabilities> {
  capabilities ??= (async () => {
    const gnomeFavorites =
      process.platform === "linux"
        ? (
            await spawnCaptured([...GNOME_FAVORITES_READ_ARGV], {
              timeoutMs: COMMAND_TIMEOUT_MS,
            }).catch((err: unknown) => {
              // No gsettings binary at all: not GNOME. Anything else is a bug.
              if (err instanceof Error && /ENOENT|not found/i.test(err.message))
                return null;
              throw err;
            })
          )?.exitCode === 0
        : false;
    return installCapabilities({ platform: process.platform, gnomeFavorites });
  })();
  return capabilities;
}
