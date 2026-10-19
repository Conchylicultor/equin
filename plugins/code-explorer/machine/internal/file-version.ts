import { serveValue } from "@plugins/network/plugins/live/machine";
import { codeFileVersion } from "@plugins/code-explorer/plugins/code-api/core";
import {
  hostPathVersion,
  watchHostPath,
} from "@plugins/infra/plugins/host-fs/machine";
import { _attempts } from "@plugins/tasks/plugins/tasks-core/server";
import { resolveInsideRoot } from "../../server/internal/contained-path";
import { resolveWorkspacePath } from "../../server/internal/resolve-worktree-path";

/** The file's absolute path, or the declared refusal. */
async function absolutePathOf(worktree: string, path: string): Promise<string> {
  const root = await resolveWorkspacePath(worktree);
  if (root === null) {
    throw codeFileVersion.refuse("no-workspace", `no workspace ${worktree}`);
  }
  const abs = resolveInsideRoot(root, path);
  if (abs === null) {
    throw codeFileVersion.refuse(
      "invalid-path",
      `${JSON.stringify(path)} is not a path inside ${worktree}`,
    );
  }
  return abs;
}

/**
 * The workspace file's revision is its host path's: host-fs stamps it and
 * watches its folder (riding the checkout watch edited-files / git status
 * already hold on the worktree). The watch's start is awaited — see
 * host-fs's `hostFsVersionServed`.
 */
export const codeFileVersionServed = serveValue(codeFileVersion, {
  source: "external",
  changes: "notified",
  reads: {
    tables: [_attempts],
    reason:
      "an attempt-id workspace resolves to its attempt row's worktree path before the file is stamped; a write to the row may move which directory the tuple reads",
  },
  loader: async ({ worktree, path }) =>
    hostPathVersion(await absolutePathOf(worktree, path)),
  whileSubscribed: async ({ worktree, path }, notify) => {
    const root = await resolveWorkspacePath(worktree);
    const abs = root === null ? null : resolveInsideRoot(root, path);
    // A refused tuple (the loader says why) has nothing to watch.
    if (abs === null) return () => {};
    const watch = await watchHostPath(abs, () => notify());
    return watch.kind === "watching" ? watch.release : () => {};
  },
});
