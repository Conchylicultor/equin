// The reset's two reads of codegen, in a module of their own so the reset can
// load them lazily (`await import("./config-propagation")`). Codegen's barrel
// is the build pipeline (docgen, the lint and format cores — eslint,
// @typescript-eslint, ~300 npm modules), and the reset is in every backend's
// boot closure, for work no boot runs. `boot:closure-no-dev-tooling` keeps it
// out.
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { compositionsConfig } from "@plugins/plugin-meta/plugins/composition/core";
import {
  propagateConfigToUser,
  readEffectiveConfigFromDisk,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";

// The `compositions` config's owning-plugin path — its jsonc files live under
// `config/<this>/` and the per-worktree user config dir (mirrors compose-serve).
const COMPOSITIONS_HIERARCHY_PATH = asPath(
  asPluginId("plugin-meta.composition"),
);

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
  // The served namespace is the owner's own (served from their checkout):
  // the same layers its serve build propagated.
  await propagateConfigToUser({ root, userConfigDir, ownerLayer: true });
}
