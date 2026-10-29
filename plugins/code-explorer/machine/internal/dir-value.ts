import { resolve } from "node:path";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { attemptWorkspacesServed } from "@plugins/tasks/plugins/tasks-core/server";
import { sliceRange } from "@plugins/network/plugins/live/server";
import type { LiveKeyRange } from "@plugins/network/plugins/live/core";
import { watchHostDir } from "@plugins/infra/plugins/host-fs/machine";
import {
  codeDir,
  type CodeDirEntry,
} from "@plugins/code-explorer/plugins/code-api/core";
import { resolveInsideRoot } from "../../server/internal/contained-path";
import { listAtRef, listOnDisk, type ListResult } from "./list-dir";
import { isAllowedRef, resolveRef } from "../../server/internal/resolve-ref";
import {
  workspaceAttemptIds,
  workspaceRootFrom,
  type WorkspaceRoot,
} from "../../server/internal/resolve-worktree-path";
import {
  checkoutRootOf,
  noWatch,
  pinnedRefs,
  refChange,
  watchCheckout,
  workspaceRootOf,
} from "./workspace";

type DirQuery = { worktree: string; dir: string; ref?: string };

/** The folder a question names, absolute under `root`, or null when it is not inside. */
function dirIn(root: string, dir: string): string | null {
  const rel = dir.replace(/\/+$/, "");
  return rel === "" ? resolve(root) : resolveInsideRoot(root, rel);
}

/** Every entry of the folder a question names, or its refusal. */
export async function listCodeDirEntries(
  q: DirQuery,
  root: WorkspaceRoot | null,
): Promise<CodeDirEntry[]> {
  const path =
    q.ref !== undefined
      ? checkoutRootOf(root, q.worktree, codeDir.refuse)
      : workspaceRootOf(root, q.worktree, codeDir.refuse);
  const rel = q.dir.replace(/\/+$/, "");
  const abs = dirIn(path, q.dir);
  if (abs === null) {
    throw codeDir.refuse(
      "invalid-path",
      `${JSON.stringify(q.dir)} is not a folder path inside ${q.worktree}`,
    );
  }
  let listed: ListResult;
  if (q.ref !== undefined) {
    if (!isAllowedRef(q.ref)) {
      throw codeDir.refuse(
        "invalid-ref",
        `${JSON.stringify(q.ref)} is not a ref`,
      );
    }
    listed = await listAtRef(path, rel, await resolveRef(path, q.ref));
  } else {
    listed = await listOnDisk(abs);
  }
  if (listed.kind === "missing") {
    throw codeDir.refuse(
      "missing",
      `No folder ${q.worktree}:${rel === "" ? "/" : rel}${q.ref === undefined ? "" : ` at ${q.ref}`}`,
    );
  }
  return listed.entries;
}

/**
 * Hear what can move a listing: on disk, the folder's entries (a
 * children-scope watch through the dir hub — any workspace kind); as of a
 * named ref, HEAD and the refs in the checkout's git dir (not the index,
 * which `ls-tree` never reads); as of a sha, nothing.
 */
async function watchListing(
  q: DirQuery,
  root: WorkspaceRoot | null,
  onChange: () => void,
): Promise<() => void> {
  if (root === null) return noWatch;
  if (q.ref !== undefined) {
    if (pinnedRefs([q.ref]) || !root.git) return noWatch;
    return watchCheckout(
      root.path,
      { main: q.ref === "main", hears: refChange },
      onChange,
    );
  }
  const abs = dirIn(root.path, q.dir);
  if (abs === null) return noWatch;
  return watchHostDir(abs, onChange);
}

/** One page of a folder's entries under `root`: its name range of the listing. */
async function listingPage(
  q: DirQuery,
  root: WorkspaceRoot | null,
  range: LiveKeyRange,
): Promise<CodeDirEntry[]> {
  return sliceRange(codeDir, await listCodeDirEntries(q, root), range);
}

/**
 * A workspace folder's entries, paged by name — every page and the meta
 * listed afresh (one `readdir` / `ls-tree`), pushed while a question is read
 * (see {@link watchListing}). Throttled: a folder being written (a build, a
 * checkout) re-lists at most once a second. The root is the workspace's
 * attempt row, FOLLOWED (`attemptWorkspaces` by the id's attempt — none for a
 * sentinel or a path): a write to that attempt's workspace re-reads the
 * question's pages and re-points its watch; any other attempt write reaches
 * none.
 */
export const codeDirServed = serveValue(codeDir, {
  source: "external",
  changes: "notified",
  follows: (follow) => ({
    ws: follow(attemptWorkspacesServed, (q) => ({
      ids: workspaceAttemptIds(q.worktree),
    })),
  }),
  throttleMs: 1_000,
  loader: async (q, range, { followed }) =>
    listingPage(q, await workspaceRootFrom(q.worktree, followed.ws), range),
  meta: async (q, { followed }) => ({
    total: (
      await listCodeDirEntries(
        q,
        await workspaceRootFrom(q.worktree, followed.ws),
      )
    ).length,
  }),
  whileFollowing: {
    over: (followed) => followed.ws,
    start: async (q, { over: ws, notify }) => {
      const root = await workspaceRootFrom(q.worktree, ws);
      const stop = await watchListing(q, root, () => notify());
      // Heard from here on: a change between the load and the watch — a
      // re-pointed one's — re-lists.
      if (stop !== noWatch) notify();
      return stop;
    },
  },
});
