import { resolve } from "node:path";
import { serveValue } from "@plugins/network/plugins/live/machine";
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
  resolveWorkspaceRoot,
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

/**
 * The workspace roots the subscribed questions read, resolved once per
 * subscription. A paged value declares no `reads` (its pages are keyed
 * windows, which no declared read reaches), so its loader may not read
 * Postgres: an attempt id's root — its attempt row — is resolved by
 * `whileSubscribed`, which the runtime awaits before any page or the meta is
 * read, and held until the last question of that workspace lets go. An
 * attempt's worktree path is set when the attempt is made; a row rewritten
 * mid-subscription is heard on the next subscription.
 */
const roots = new Map<
  string,
  { holders: number; root: Promise<WorkspaceRoot | null> }
>();

function holdRoot(worktree: string): {
  root: Promise<WorkspaceRoot | null>;
  release: () => void;
} {
  let entry = roots.get(worktree);
  if (entry === undefined) {
    entry = { holders: 0, root: resolveWorkspaceRoot(worktree) };
    roots.set(worktree, entry);
  }
  entry.holders += 1;
  const held = entry;
  return {
    root: held.root,
    release: () => {
      held.holders -= 1;
      if (held.holders === 0 && roots.get(worktree) === held) {
        roots.delete(worktree);
      }
    },
  };
}

/** The held root of `worktree`'s workspace (see {@link roots}). */
async function heldRoot(worktree: string): Promise<WorkspaceRoot | null> {
  const entry = roots.get(worktree);
  if (entry === undefined) {
    throw new Error(
      `code.dir: ${worktree}'s root is read only while a question of it is subscribed`,
    );
  }
  return entry.root;
}

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

/** One page of a folder's entries: its name range of the listing. */
async function listingPage(
  q: DirQuery,
  range: LiveKeyRange,
): Promise<CodeDirEntry[]> {
  const entries = await listCodeDirEntries(q, await heldRoot(q.worktree));
  return sliceRange(codeDir, entries, range);
}

/**
 * A workspace folder's entries, paged by name — every page and the meta
 * listed afresh (one `readdir` / `ls-tree`), pushed while a question is read
 * (see {@link watchListing}). Throttled: a folder being written (a build, a
 * checkout) re-lists at most once a second.
 */
export const codeDirServed = serveValue(codeDir, {
  source: "external",
  changes: "notified",
  throttleMs: 1_000,
  loader: listingPage,
  meta: async (q) => ({
    total: (await listCodeDirEntries(q, await heldRoot(q.worktree))).length,
  }),
  whileSubscribed: async (q, notify) => {
    const held = holdRoot(q.worktree);
    try {
      const stop = await watchListing(q, await held.root, () => notify());
      return () => {
        stop();
        held.release();
      };
    } catch (err) {
      held.release();
      throw err;
    }
  },
});
