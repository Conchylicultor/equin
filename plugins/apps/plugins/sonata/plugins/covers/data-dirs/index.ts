import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * Rendered Sonata song covers, one SVG per (score content, renderer version).
 *
 * `cache`, and genuinely so: the filename is `sha256(contentHash|version)`, so
 * anything deleted here is re-rendered on its next request.
 *
 * Host-global (outside every worktree) on purpose: two worktrees holding a
 * byte-identical song address the same file and share one render, while a
 * worktree whose renderer changed (a bumped `COVER_RENDER_VERSION`) addresses a
 * different one.
 */
export const scoreCoverCacheDir = defineDataDir({
  kind: "cache",
  name: "sonata-covers",
  owner: "apps/sonata/covers",
  description:
    "Rendered Sonata song covers (SVG), keyed by score content hash and renderer version",
  reclaim: { kind: "safe" },
});

export default [scoreCoverCacheDir];
