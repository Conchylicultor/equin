import { basename } from "node:path";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { watchHostPath } from "@plugins/infra/plugins/host-fs/machine";
import {
  loadWorkspaceRoot,
  watchCheckout,
  watchWorkspaceRoot,
  workspaceRootReads,
} from "@plugins/code-explorer/machine";
import {
  RESOLVE_MAX_MATCHES,
  resolvedFile,
  type ResolvedFile,
} from "../../shared/resolved-file";
import { cleanQuery, resolveFilePath, targetOf } from "./resolve-path";

/** Where a `code.resolve-file` tuple resolves, or its refusal. */
export async function loadResolvedFile({
  worktree,
  path,
}: {
  worktree: string;
  path: string;
}): Promise<ResolvedFile> {
  // A path that names nothing is answered before the workspace is looked up.
  if (!path || path.includes("\0")) return { kind: "not-found" };
  const root = await loadWorkspaceRoot(worktree);
  if (root === null) {
    throw resolvedFile.refuse("no-workspace", `no workspace ${worktree}`);
  }
  // Any workspace kind: a scratch dir answers its exact paths, and has no
  // file list to match the rest against.
  return resolveFilePath(root.path, path, RESOLVE_MAX_MATCHES, root.git);
}

/**
 * Hear what can move a resolution: the entry the path names, wherever it is
 * (an `exact` answer is its existence, inside the checkout or not, ignored or
 * not); and in a checkout, over the checkout watch, what moves its
 * `ls-files`: a file created or removed, its index, or an edit to a
 * `.gitignore` (which can un-ignore files already there — no create says so).
 * Any other edit moves neither.
 */
async function watchResolution(
  { worktree, path }: { worktree: string; path: string },
  onChange: () => void,
): Promise<() => void> {
  if (!path || path.includes("\0")) return () => {};
  return watchWorkspaceRoot(worktree, onChange, async (root) => {
    const stops: (() => void)[] = [];
    const stopAll = () => {
      for (const stop of stops.splice(0)) stop();
    };
    try {
      if (root.git) {
        stops.push(
          await watchCheckout(
            root.path,
            {
              main: false,
              hears: (c) =>
                c.area === "git" ||
                c.type !== "update" ||
                basename(c.path) === ".gitignore",
            },
            onChange,
          ),
        );
      }
      const cleaned = cleanQuery(path);
      if (cleaned) {
        stops.push(await watchHostPath(targetOf(root.path, cleaned), onChange));
      }
    } catch (err) {
      stopAll();
      throw err;
    }
    return stopAll;
  });
}

/**
 * A path's resolution, pushed while read. Throttled: a checkout or a build
 * creating many files re-resolves at most once a second.
 */
export const resolvedFileServed = serveValue(resolvedFile, {
  source: "external",
  changes: "notified",
  reads: workspaceRootReads,
  throttleMs: 1_000,
  loader: loadResolvedFile,
  whileSubscribed: (q, notify) => watchResolution(q, () => notify()),
});
