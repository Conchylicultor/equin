import { serveValue, sliceRange } from "@plugins/network/plugins/live/server";
import type { LiveKeyRange } from "@plugins/network/plugins/live/core";
import { createRefcountHub } from "@plugins/packages/plugins/refcount-hub/core";
import {
  InvalidRelPathError,
  dataFileRoots,
  dataFileStat,
  dataFolderListing,
  isWithinRel,
  parseRelPath,
  type BrowsableRoot,
  type DataChange,
  type DataFileStat,
  type DataFolderMeta,
  type FileEntry,
  type RelPath,
} from "../../core";
import { DataFiles } from "./service";
import {
  browsableFileRoot,
  browsableFileRoots,
  type WatchedFileRoot,
} from "./root";

// The listing surface over every root declared `browse`, served on every host
// (the desktop's disk, a browser host's memory): the roots (each with where
// its folder is), a folder's entries (paged) and one path's stat — each
// refusing what it cannot answer by code. A file's contents are file-systems'
// reads at the root's location. Pushed from the root's own watch, one
// subscription per root however many reads hold it.

/** What a person reads of a root. */
function infoOf(root: WatchedFileRoot): BrowsableRoot {
  // `browsableFileRoots` holds only roots that declare `browse`.
  const label = root.spec.browse?.label ?? root.id;
  return {
    id: root.id,
    label,
    dir: root.spec.dir,
    location: DataFiles.get().location(root.spec),
  };
}

/** The browsable roots of this host — a fixed set, the build's declarations. */
export const dataFileRootsServed = serveValue(dataFileRoots, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "roots are declared in code at module evaluation; the set changes only with a build",
    },
  },
  loader: () => browsableFileRoots().map(infoOf),
});

/** A read's refusal codes this module throws, shared by every value. */
type RefuseFn = (
  code: "unknown-root" | "invalid-path",
  message: string,
) => Error;

/** The root `id` and the path `raw` inside it, or the refusal saying why not. */
function locate(
  refuse: RefuseFn,
  id: string,
  raw: string | undefined,
): { root: WatchedFileRoot; path: RelPath } {
  const root = browsableFileRoot(id);
  if (root === undefined) {
    throw refuse("unknown-root", `No browsable file root "${id}"`);
  }
  try {
    return { root, path: parseRelPath(raw ?? "") };
  } catch (err) {
    if (err instanceof InvalidRelPathError) {
      throw refuse("invalid-path", err.message);
    }
    throw err;
  }
}

/**
 * Each root's changes, one watch per root while anything reads it. A reader
 * filters what concerns it ({@link touches}).
 */
const rootChanges = createRefcountHub<DataChange>(async (id, emit) => {
  const root = browsableFileRoot(id);
  if (root === undefined) {
    throw new Error(`[data-files] no browsable root "${id}" to watch`);
  }
  const watch = await root.watch((change) => emit(change));
  return () => watch.dispose();
});

/**
 * Whether `change` may move what a read of `path` shows: a rescan always; a
 * changed path at `path` or below it (a folder's listing moves with any
 * descendant — a new sub-folder appears, a child's size or time moves); or
 * `path`'s own ancestors (a removed folder takes `path` with it).
 */
function touches(change: DataChange, path: RelPath): boolean {
  if (change.kind === "rescan") return true;
  return change.paths.some(
    (changed) => isWithinRel(changed, path) || isWithinRel(path, changed),
  );
}

/** Hear the changes of root `id` that touch `path` until the stop runs. */
async function watchPath(
  id: string,
  path: RelPath,
  notify: () => void,
): Promise<() => void> {
  const hold = rootChanges.acquire(id, (change) => {
    if (touches(change, path)) notify();
  });
  await hold.ready;
  return () => hold.release();
}

/** `path` without its refusal checks — the watch of a read that will refuse watches nothing. */
function locatedOrNull(
  id: string,
  raw: string | undefined,
): { root: WatchedFileRoot; path: RelPath } | null {
  const root = browsableFileRoot(id);
  if (root === undefined) return null;
  try {
    return { root, path: parseRelPath(raw ?? "") };
  } catch (err) {
    if (err instanceof InvalidRelPathError) return null;
    throw err;
  }
}

// ── list ─────────────────────────────────────────────────────────────────────

/** A folder's entries in code-point order by name, or the refusal. */
async function folderEntries(q: {
  root: string;
  path?: string;
}): Promise<{ path: RelPath; entries: FileEntry[] }> {
  const { root, path } = locate(dataFolderListing.refuse, q.root, q.path);
  const stat = path === "" ? null : await root.stat(path);
  if (stat !== null) {
    if (stat.kind === "missing") {
      throw dataFolderListing.refuse(
        "missing",
        `Nothing at "${path}" in ${root.id}`,
      );
    }
    if (stat.entry.kind !== "dir") {
      throw dataFolderListing.refuse(
        "not-a-dir",
        `"${path}" in ${root.id} is a file`,
      );
    }
  }
  const listed = await root.list(path);
  // Removed between the stat and the list: as missing as it was never there.
  if (listed.kind === "missing") {
    throw dataFolderListing.refuse(
      "missing",
      `Nothing at "${path}" in ${root.id}`,
    );
  }
  const entries = [...listed.entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return { path, entries };
}

/**
 * A root folder's entries, paged by name: each page cut from one list of the
 * folder, the meta its total — pushed from the root's watch while read.
 */
export const dataFolderListingServed = serveValue(dataFolderListing, {
  source: "external",
  changes: "notified",
  throttleMs: 1_000,
  loader: async (q, range: LiveKeyRange) =>
    sliceRange(dataFolderListing, (await folderEntries(q)).entries, range),
  meta: async (q): Promise<DataFolderMeta> => {
    const { path, entries } = await folderEntries(q);
    return { root: q.root, path, total: entries.length };
  },
  whileSubscribed: async (q, notify) => {
    const at = locatedOrNull(q.root, q.path);
    // The loader refuses it; there is nothing to watch.
    if (at === null) return () => {};
    return watchPath(at.root.id, at.path, () => notify());
  },
});

// ── stat ─────────────────────────────────────────────────────────────────────

export const dataFileStatServed = serveValue(dataFileStat, {
  source: "external",
  changes: "notified",
  loader: async ({ root: id, path: raw }): Promise<DataFileStat> => {
    const { root, path } = locate(dataFileStat.refuse, id, raw);
    if (path === "") {
      // The root itself: a folder that is always there.
      return {
        root: id,
        path,
        entry: {
          name: root.id,
          kind: "dir",
          size: 0,
          mtimeMs: 0,
          birthtimeMs: 0,
        },
      };
    }
    const stat = await root.stat(path);
    if (stat.kind === "missing") {
      throw dataFileStat.refuse("missing", `Nothing at "${path}" in ${id}`);
    }
    return { root: id, path, entry: stat.entry };
  },
  whileSubscribed: async ({ root: id, path: raw }, notify) => {
    const at = locatedOrNull(id, raw);
    if (at === null) return () => {};
    return watchPath(at.root.id, at.path, () => notify());
  },
});
