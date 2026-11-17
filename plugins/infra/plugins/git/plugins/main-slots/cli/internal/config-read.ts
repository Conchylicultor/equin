import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { readEffectiveConfigFromDiskSync } from "@plugins/config_v2/plugins/disk-read/core";
import { configDir } from "@plugins/config_v2/data-dirs";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { mainSlotsConfig } from "../../shared/config";

// The config's owning plugin — where its jsonc files live under `config/`
// and in main's user config dir.
const MAIN_SLOTS_HIERARCHY_PATH = asPath(asPluginId("infra.git.main-slots"));

/**
 * The slow-drain threshold, in ms, as main's config says it (read off disk:
 * a CLI process has no config runtime) — what a slot stamped unserved now
 * carries to the processes that release it later.
 */
export function readDrainReportAfterMs(root: AppPath = REPO_ROOT): number {
  return (
    readEffectiveConfigFromDiskSync(mainSlotsConfig, {
      root,
      userConfigDir: configDir.file(MAIN_WORKTREE_NAME),
      hierarchyPath: MAIN_SLOTS_HIERARCHY_PATH,
    }).drainReportAfterSec * 1000
  );
}
