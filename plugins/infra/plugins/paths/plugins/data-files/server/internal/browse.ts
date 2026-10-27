import { serveValue, sliceRange } from "@plugins/network/plugins/live/server";
import type { LiveKeyRange } from "@plugins/network/plugins/live/core";
import { createRefcountHub } from "@plugins/packages/plugins/refcount-hub/core";
import {
  DATA_FILE_TEXT_MAX_BYTES,
  InvalidRelPathError,
  dataFileRoots,
  dataFileStat,
  dataFileText,
  dataFolderListing,
  isWithinRel,
  parseRelPath,
  relName,
  type BrowsableRoot,
  type DataChange,
  type DataFileStat,
  type DataFileText,
  type DataFolderMeta,
  type FileEntry,
  type RelPath,
} from "../../core";
import {
  browsableFileRoot,
  browsableFileRoots,
  type WatchedFileRoot,
} from "./root";

// The read surface over every root declared `browse`, served on every host
// (the desktop's disk, a browser host's memory): the roots, a folder's entries
// (paged), one path's stat, a file's text — each refusing what it cannot
// answer by code — and the raw route. Pushed from the root's own watch, one
// subscription per root however many reads hold it.

/** What a person reads of a root. */
function infoOf(root: WatchedFileRoot): BrowsableRoot {
  // `browsableFileRoots` holds only roots that declare `browse`.
  const label = root.spec.browse?.label ?? root.id;
  return { id: root.id, label, dir: root.spec.dir };
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

// ── text ─────────────────────────────────────────────────────────────────────

/** How many leading bytes the binary sniff reads — git's and host-fs's heuristic. */
const SNIFF_BYTES = 8000;

export const dataFileTextServed = serveValue(dataFileText, {
  source: "external",
  changes: "notified",
  loader: async ({ root: id, path: raw }): Promise<DataFileText> => {
    const { root, path } = locate(dataFileText.refuse, id, raw);
    if (path === "") {
      throw dataFileText.refuse("not-a-file", `The root of ${id} is a folder`);
    }
    const stat = await root.stat(path);
    if (stat.kind === "missing") {
      throw dataFileText.refuse("missing", `Nothing at "${path}" in ${id}`);
    }
    if (stat.entry.kind !== "file") {
      throw dataFileText.refuse("not-a-file", `"${path}" in ${id} is a folder`);
    }
    // Gated before the read: a huge file is never pulled into memory.
    if (stat.entry.size > DATA_FILE_TEXT_MAX_BYTES) {
      throw dataFileText.refuse(
        "too-large",
        `${relName(path)} is ${stat.entry.size} bytes, over the ${DATA_FILE_TEXT_MAX_BYTES}-byte limit`,
      );
    }
    const read = await root.read(path);
    if (read.kind === "missing") {
      throw dataFileText.refuse("missing", `Nothing at "${path}" in ${id}`);
    }
    const bytes = new Uint8Array(await read.blob.arrayBuffer());
    if (bytes.length > DATA_FILE_TEXT_MAX_BYTES) {
      throw dataFileText.refuse(
        "too-large",
        `${relName(path)} is ${bytes.length} bytes, over the ${DATA_FILE_TEXT_MAX_BYTES}-byte limit`,
      );
    }
    if (bytes.subarray(0, SNIFF_BYTES).includes(0)) {
      throw dataFileText.refuse("binary", `${relName(path)} is a binary file`);
    }
    return {
      root: id,
      path,
      content: new TextDecoder().decode(bytes),
      size: bytes.length,
    };
  },
  whileSubscribed: async ({ root: id, path: raw }, notify) => {
    const at = locatedOrNull(id, raw);
    if (at === null) return () => {};
    return watchPath(at.root.id, at.path, () => notify());
  },
});

// ── raw ──────────────────────────────────────────────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
};

function contentTypeOf(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot <= 0 ? "" : name.slice(dot).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * `GET /api/data-files/:root/raw?path=` — a browsable root's file, verbatim.
 * Inert on the app's origin as host-fs's raw route is: never sniffed, never
 * able to run script as the app (`sandbox`, a PDF excepted — its viewer
 * refuses a sandboxed document), never embeddable by another site.
 */
export async function handleDataFileRaw(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const root =
    params.root === undefined ? undefined : browsableFileRoot(params.root);
  if (root === undefined) return new Response("unknown root", { status: 404 });
  const raw = new URL(req.url, "http://localhost").searchParams.get("path");
  if (raw === null) return new Response("missing path", { status: 400 });
  let path: RelPath;
  try {
    path = parseRelPath(raw);
  } catch (err) {
    if (err instanceof InvalidRelPathError) {
      return new Response("invalid path", { status: 400 });
    }
    throw err;
  }
  if (path === "") return new Response("not a file", { status: 404 });
  const stat = await root.stat(path);
  if (stat.kind === "missing" || stat.entry.kind !== "file") {
    return new Response("not found", { status: 404 });
  }
  const read = await root.read(path);
  if (read.kind === "missing")
    return new Response("not found", { status: 404 });
  const name = relName(path);
  const contentType = contentTypeOf(name);
  return new Response(read.blob, {
    headers: {
      "content-type": contentType,
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-content-type-options": "nosniff",
      ...(contentType === "application/pdf"
        ? {}
        : { "content-security-policy": "sandbox" }),
      "cross-origin-resource-policy": "same-site",
      "cache-control": "no-cache",
    },
  });
}

// ── for other readers of a browsable root's files ───────────────────────────

/**
 * A browsable root's file as bytes — for a reader that serves file bytes from
 * every source (file-viewer's `file-viewer.bytes`). Every miss is typed.
 */
export type BrowsableFileBytes =
  | { kind: "file"; bytes: ArrayBuffer; entry: FileEntry }
  | { kind: "unknown-root" }
  | { kind: "invalid-path"; message: string }
  | { kind: "missing" }
  | { kind: "not-a-file" }
  | { kind: "too-large"; size: number };

/** Read `raw` in browsable root `id`, refusing past `maxBytes` before reading. */
export async function readBrowsableFile(
  id: string,
  raw: string,
  maxBytes: number,
): Promise<BrowsableFileBytes> {
  const root = browsableFileRoot(id);
  if (root === undefined) return { kind: "unknown-root" };
  let path: RelPath;
  try {
    path = parseRelPath(raw);
  } catch (err) {
    if (err instanceof InvalidRelPathError) {
      return { kind: "invalid-path", message: err.message };
    }
    throw err;
  }
  if (path === "") return { kind: "not-a-file" };
  const stat = await root.stat(path);
  if (stat.kind === "missing") return { kind: "missing" };
  if (stat.entry.kind !== "file") return { kind: "not-a-file" };
  if (stat.entry.size > maxBytes) {
    return { kind: "too-large", size: stat.entry.size };
  }
  const read = await root.read(path);
  if (read.kind === "missing") return { kind: "missing" };
  const bytes = await read.blob.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    return { kind: "too-large", size: bytes.byteLength };
  }
  return { kind: "file", bytes, entry: read.entry };
}

/**
 * A browsable root's path's revision — its kind, size and mtime, or
 * `"missing"` / `"invalid"` — for an ETag probed before a read.
 */
export async function browsableFileRevision(
  id: string,
  raw: string,
): Promise<string> {
  const at = locatedOrNull(id, raw);
  if (at === null) return "invalid";
  if (at.path === "") return "root";
  const stat = await at.root.stat(at.path);
  if (stat.kind === "missing") return "missing";
  return `${stat.entry.kind}:${stat.entry.size}:${stat.entry.mtimeMs}`;
}

/**
 * Hear the changes of browsable root `id` that touch `raw` until the returned
 * stop runs — the root's own watch, shared with every other read of it. A root
 * or path that names nothing has nothing to watch.
 */
export async function watchBrowsableFile(
  id: string,
  raw: string,
  onChange: () => void,
): Promise<() => void> {
  const at = locatedOrNull(id, raw);
  if (at === null) return () => {};
  return watchPath(at.root.id, at.path, onChange);
}
