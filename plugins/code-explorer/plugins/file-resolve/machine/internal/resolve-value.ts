import { basename } from "node:path";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { watchHostPath } from "@plugins/infra/plugins/host-fs/machine";
import { attemptWorkspacesServed } from "@plugins/tasks/plugins/tasks-core/server";
import {
  watchCheckout,
  workspaceAttemptIds,
  workspaceRootFrom,
  type WorkspaceRoot,
} from "@plugins/code-explorer/machine";
import {
  RESOLVE_MAX_MATCHES,
  resolvedFile,
  type ResolvedFile,
} from "../../shared/resolved-file";
import { cleanQuery, resolveFilePath, targetOf } from "./resolve-path";
import { asUserPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/** Where a `code.resolve-file` tuple resolves under its workspace's `root`, or its refusal. */
export async function loadResolvedFile(
  {
    worktree,
    path,
  }: {
    worktree: string;
    path: string;
  },
  root: WorkspaceRoot | null,
): Promise<ResolvedFile> {
  // A path that names nothing is answered before the workspace is asked about.
  if (!path || path.includes("\0")) return { kind: "not-found" };
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
 * Any other edit moves neither. No workspace (`root` null) has nothing to
 * watch until its root moves, which re-points the watch; `onChange` runs
 * once it is open, so a change between the load and the watch is heard.
 */
async function watchResolution(
  { path }: { path: string },
  root: WorkspaceRoot | null,
  onChange: () => void,
): Promise<() => void> {
  if (!path || path.includes("\0") || root === null) return () => {};
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
      stops.push(
        await watchHostPath(asUserPath(targetOf(root.path, cleaned)), onChange),
      );
    }
  } catch (err) {
    stopAll();
    throw err;
  }
  onChange();
  return stopAll;
}

/**
 * A path's resolution, pushed while read. Throttled: a checkout or a build
 * creating many files re-resolves at most once a second. The root is the
 * workspace's attempt row, FOLLOWED (`attemptWorkspaces` by the id's attempt
 * — none for a sentinel or a path), so only a write to that attempt's
 * workspace reaches the tuple, and re-points its watch.
 */
export const resolvedFileServed = serveValue(resolvedFile, {
  source: "external",
  changes: "notified",
  follows: (follow) => ({
    ws: follow(attemptWorkspacesServed, ({ worktree }) => ({
      ids: workspaceAttemptIds(worktree),
    })),
  }),
  throttleMs: 1_000,
  loader: async (q, { followed }) =>
    loadResolvedFile(q, await workspaceRootFrom(q.worktree, followed.ws)),
  whileFollowing: {
    over: (followed) => followed.ws,
    start: async (q, { over: ws, notify }) =>
      watchResolution(q, await workspaceRootFrom(q.worktree, ws), () =>
        notify(),
      ),
  },
});
