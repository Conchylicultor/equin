import { defineFileRoot } from "@plugins/infra/plugins/paths/plugins/data-files/server";

/**
 * The mirror's cache, `<mirror id>/<file>`, over the `cache/asset-mirror` data
 * dir: the computer's disk on the desktop (bound by this plugin's `machine/`,
 * shared by every worktree and seeded by a release bundle), the host's
 * data-files store in a browser host — kept in the host's storage
 * (`browser-server/host-storage`), so a persistent host fetches a file from
 * its remote once per browser profile.
 */
export const assetMirrorFiles = defineFileRoot({
  id: "infra.asset-mirror",
  dir: "cache/asset-mirror",
});
