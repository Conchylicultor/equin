import { serveValue } from "@plugins/network/plugins/live/server";
import { runGit } from "@plugins/primitives/plugins/commit-list/server";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { hashHex } from "@plugins/packages/plugins/string-hash/core";
import { gitTags } from "../../core";

/**
 * Notified by the ref watcher (./watcher.ts) when `refs/tags/` gains or loses
 * an entry, or `packed-refs` changes (a packed tag deleted, `pack-refs`).
 */
export const gitTagsServed = serveValue(gitTags, {
  source: "external",
  changes: "notified",
  loader: async () => {
    const listing = await runGit(
      ["for-each-ref", "--format=%(refname) %(objectname)", "refs/tags/"],
      await ensureMainWorktreeRoot(),
    );
    return { digest: hashHex(listing) };
  },
});
