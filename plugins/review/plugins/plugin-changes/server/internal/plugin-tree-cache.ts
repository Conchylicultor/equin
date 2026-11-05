import {
  appPathParent,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { loadRepoFiles } from "@plugins/framework/plugins/tooling/core";
import type { PluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { buildFacetedPluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/plugins/faceted/core";
import { createGitStateMemo } from "@plugins/infra/plugins/git/plugins/git-read-cache/server";
import { withHeavyReadSlot } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import { lastKnownMainSha } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { runGit } from "@plugins/primitives/plugins/commit-list/server";
import { editedFilesSignature } from "@plugins/conversations/plugins/conversation-view/plugins/code/server";

// buildFacetedPluginTree is a build-time primitive: a fully synchronous recursive
// readdirSync walk over hundreds of plugin dirs plus per-node facet extraction
// (several facets walk every .ts file in the repo). It blocks the event loop
// for tens of seconds. computePluginChanges only needs the two trees, so each
// side is memoized independently here on a cheap, ungated signature — an
// unchanged side is a pure cache hit that does zero work and takes no heavy
// slot. The signatureFn stays ungated; the computeFn owns withHeavyReadSlot, so
// hits skip the gate entirely (cf. commits-graph compute-graph.ts).

// MAIN tree: keyed by the (constant) mainPluginsDir → a single cache entry,
// shared across every conversation on this backend, with backend-wide
// single-flight. Signature = main's HEAD sha, so the main tree is rebuilt only
// when main actually advances — never on a worktree file save. When a main
// advance fans out via refHeadServed to N active reviews, they all coalesce
// onto ONE rebuild.
const mainTreeMemo = createGitStateMemo<PluginTree>({
  name: "review.plugin-changes.main-tree",
});

export function getMainPluginTree(
  mainPluginsDir: AppPath,
): Promise<PluginTree> {
  return mainTreeMemo.get(
    mainPluginsDir,
    async () =>
      // runGit throws on failure — a failed read must never coalesce to "" and
      // poison the cache signature (two different failures would collide). A throw
      // aborts the memo recompute, retaining the previous cached tree (stale-safe).
      lastKnownMainSha() ??
      (await runGit(["rev-parse", "main"], mainPluginsDir)).trim(),
    () =>
      withHeavyReadSlot(async () =>
        buildFacetedPluginTree(mainPluginsDir, {
          repo: await loadRepoFiles(appPathParent(mainPluginsDir)),
        }),
      ),
  );
}

// WORKTREE tree: keyed by worktreePath. Signature = the edited-files CONTENT
// signature (headSha, merge-base, and each dirty file's lstat mtime+size) — the
// same cheap ungated probe the edited-files resource keys on. It moves on any
// worktree file save, so it is faithful and never stale: a stale tree would
// require a worktree file change that left every dirty file's mtime/size and the
// two SHAs untouched, which cannot happen.
//
// It replaces the edited-files watcher generation counter, which was not a
// fingerprint of git state at all (see
// research/2026-07-09-global-etag-value-coproduction.md). The content signature
// is strictly fresher — the counter only advanced after the watcher's 200ms/2s
// debounce — and a safe over-approximation in the other direction: a bare `main`
// advance now moves the merge-base and forces one worktree-tree rebuild that the
// counter would have hit. Correctness is unaffected either way; this memo is not
// skewed (`pluginChangesServed` is a pushed value with no `revalidate`, so it has
// no ETag/value pair to keep in agreement) and it only needs a faithful, fresh
// signal.
const worktreeTreeMemo = createGitStateMemo<PluginTree>({
  name: "review.plugin-changes.worktree-tree",
});

export function getWorktreePluginTree(
  worktreePath: string,
  worktreePluginsDir: AppPath,
): Promise<PluginTree> {
  return worktreeTreeMemo.get(
    worktreePath,
    () => editedFilesSignature(worktreePath),
    () =>
      withHeavyReadSlot(async () =>
        buildFacetedPluginTree(worktreePluginsDir, {
          repo: await loadRepoFiles(appPathParent(worktreePluginsDir)),
        }),
      ),
  );
}
