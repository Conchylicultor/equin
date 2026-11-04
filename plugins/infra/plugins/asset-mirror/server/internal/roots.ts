import { defineFileRoot } from "@plugins/infra/plugins/paths/plugins/data-files/server";

/**
 * The mirror's cache, `<mirror id>/<file>`, over the `cache/asset-mirror` data
 * dir: the computer's disk on the desktop (bound by this plugin's `machine/`,
 * shared by every worktree and seeded by a release bundle), memory in a
 * browser host — where a file is fetched from its remote once per session.
 */
export const assetMirrorFiles = defineFileRoot({
  id: "infra.asset-mirror",
  dir: "cache/asset-mirror",
});
