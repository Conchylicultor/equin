// The reset's two config reads/writes. Neither runs build tooling in this
// process (`boot:closure-digestable`): the manifest read is a plain off-disk
// read (`config_v2/disk-read`), and re-propagation — which has to evaluate
// every plugin barrel to find the configs — runs as `./equin config-propagate`
// in a child.
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { compositionsConfig } from "@plugins/plugin-meta/plugins/composition/core";
import { readEffectiveConfigFromDisk } from "@plugins/config_v2/plugins/disk-read/core";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";

// The `compositions` config's owning-plugin path — its jsonc files live under
// `config/<this>/` and the per-worktree user config dir (mirrors compose-serve).
const COMPOSITIONS_HIERARCHY_PATH = asPath(
  asPluginId("plugin-meta.composition"),
);

/**
 * Wedge-breaker, far above a cold propagation (every plugin barrel evaluated:
 * seconds on a quiet machine).
 */
const PROPAGATE_TIMEOUT_MS = 10 * 60_000;

/** The checkout's resolved `compositions` config, as `userConfigDir` layers it. */
export function readCompositionManifests(
  root: AppPath,
  userConfigDir: AppPath,
) {
  return readEffectiveConfigFromDisk(compositionsConfig, {
    root,
    userConfigDir,
    hierarchyPath: COMPOSITIONS_HIERARCHY_PATH,
  });
}

/** Re-propagate the checkout's git-layer config defaults into `userConfigDir`. */
export async function repropagateConfig(
  root: AppPath,
  userConfigDir: AppPath,
): Promise<void> {
  await spawnExpectOk([`./${CLI_NAME}`, "config-propagate", userConfigDir], {
    cwd: root,
    timeoutMs: PROPAGATE_TIMEOUT_MS,
  });
}
