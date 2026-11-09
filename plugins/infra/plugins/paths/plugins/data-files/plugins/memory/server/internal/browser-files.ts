import { serveValue } from "@plugins/network/plugins/live/server";
import { createRefcountHub } from "@plugins/packages/plugins/refcount-hub/core";
import {
  InvalidRelPathError,
  isWithinRel,
  parseRelPath,
  type DataChange,
  type FileEntry as RootEntry,
  type RelPath,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import {
  listFileRoots,
  type FileRoot,
  type WatchedFileRoot,
} from "@plugins/infra/plugins/paths/plugins/data-files/server";
import {
  FILE_BYTES_MAX,
  FILE_TEXT_MAX_BYTES,
  browserFileBytes,
  browserFileStat,
  browserFileText,
  contentTypeOf,
  type FileEntry,
  type FileStat,
  type FileText,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { DATA_FOLDER } from "./home-layout";

// The browser's file system (`{ fs: "browser" }`): this host's storage laid out
// like a home folder, so a reader names a file by a path and never by which
// app keeps it. `~` is its root; the apps' folders sit where the desktop keeps
// them, under the hidden `~/.equin/` — each declared file root at its data dir
// (`~/.equin/apps/prototypes/…`). The folders above a root are implied by the
// roots there are. Served only by a browser host (this plugin is never booted
// on the desktop, where the same folders are on the computer's disk).

/** Where a path of the browser's file system lands. */
type Located =
  | { kind: "folder"; name: string }
  | { kind: "in-root"; root: FileRoot; path: RelPath }
  | { kind: "missing" };

/** Why a spelling is not a path of the browser's file system. */
class InvalidBrowserPath extends Error {}

/** The path's segments below `~` (`~/a/b`, `/a/b` and `a/b` alike), or a throw. */
function segmentsOf(path: string): string[] {
  if (path.includes("\0")) throw new InvalidBrowserPath("A path has no NUL");
  const rest = path === "~" ? "" : path.startsWith("~/") ? path.slice(2) : path;
  const segments = rest.split("/").filter((segment) => segment !== "");
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new InvalidBrowserPath(
        `${JSON.stringify(path)} is not a path: no "." or ".." segment`,
      );
    }
  }
  return segments;
}

/** The roots whose data dir sits at or below `dir` (`apps`, `apps/prototypes`). */
function rootsUnder(dir: string): FileRoot[] {
  return listFileRoots().filter(
    (root) => root.spec.dir === dir || root.spec.dir.startsWith(`${dir}/`),
  );
}

/** Where `path` lands: a folder the roots imply, a path inside a root, or nothing. */
function locate(path: string): Located {
  const segments = segmentsOf(path);
  if (segments.length === 0) return { kind: "folder", name: "~" };
  if (segments[0] !== DATA_FOLDER) return { kind: "missing" };
  const below = segments.slice(1);
  // A data dir is `${kind}/${name}`: the two segments under ~/.equin.
  if (below.length < 2) {
    const dir = below.join("/");
    if (dir !== "" && rootsUnder(dir).length === 0) return { kind: "missing" };
    return { kind: "folder", name: segments.at(-1)! };
  }
  const dir = `${below[0]}/${below[1]}`;
  const root = listFileRoots().find((r) => r.spec.dir === dir);
  if (root === undefined) return { kind: "missing" };
  try {
    return {
      kind: "in-root",
      root,
      path: parseRelPath(below.slice(2).join("/")),
    };
  } catch (err) {
    if (err instanceof InvalidRelPathError) {
      throw new InvalidBrowserPath(err.message);
    }
    throw err;
  }
}

/** A root's entry, as every file system's. */
function entryOf(entry: RootEntry): FileEntry {
  return {
    name: entry.name,
    kind: entry.kind,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    birthtimeMs: entry.birthtimeMs,
    hidden: entry.name.startsWith("."),
  };
}

/** A folder the roots imply (or a root's own folder): always there, never dated. */
function folderEntry(name: string): FileEntry {
  return {
    name,
    kind: "dir",
    size: 0,
    mtimeMs: 0,
    hidden: name.startsWith("."),
  };
}

/** The last segment of a path in a root. */
function nameOf(path: RelPath): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

type Refuse = (code: "invalid-path", message: string) => Error;

/** `path` located, its bad spelling refused as `invalid-path`. */
function locateOrRefuse(refuse: Refuse, path: string): Located {
  try {
    return locate(path);
  } catch (err) {
    if (err instanceof InvalidBrowserPath)
      throw refuse("invalid-path", err.message);
    throw err;
  }
}

// ── watching ─────────────────────────────────────────────────────────────────

/** The root's watch, when it declares one (`defineFileRoot` gave it `watch`). */
function watchedRoot(root: FileRoot): WatchedFileRoot | null {
  return "watch" in root ? (root as WatchedFileRoot) : null;
}

/** Each watched root's changes, one watch per root while anything reads it. */
const rootChanges = createRefcountHub<DataChange>(async (id, emit) => {
  const root = listFileRoots().find((r) => r.id === id);
  const watched = root === undefined ? null : watchedRoot(root);
  if (watched === null) {
    throw new Error(`[data-files] no watched root "${id}" to watch`);
  }
  const watch = await watched.watch((change) => emit(change));
  return () => watch.dispose();
});

/**
 * Hear the changes that may move what a read of `path` shows, until the stop
 * runs: a change at, below or above it in its root. A path above every root
 * (a folder the roots imply) moves only with a build; a root declared without
 * a watch (a cache) is never pushed — its readers see it as of their read.
 */
async function watchPath(
  path: string,
  notify: () => void,
): Promise<() => void> {
  let at: Located;
  try {
    at = locate(path);
  } catch (err) {
    // The loader refuses the spelling; there is nothing to watch.
    if (err instanceof InvalidBrowserPath) return () => {};
    throw err;
  }
  if (at.kind !== "in-root" || watchedRoot(at.root) === null) return () => {};
  const within = at.path;
  const hold = rootChanges.acquire(at.root.id, (change) => {
    if (
      change.kind === "rescan" ||
      change.paths.some(
        (changed) =>
          isWithinRel(changed, within) || isWithinRel(within, changed),
      )
    )
      notify();
  });
  await hold.ready;
  return () => hold.release();
}

// ── reads ────────────────────────────────────────────────────────────────────

/** One path of the browser's file system described. */
export const browserFileStatServed = serveValue(browserFileStat, {
  source: "external",
  changes: "notified",
  loader: async ({ path }): Promise<FileStat> => {
    const at = locateOrRefuse(browserFileStat.refuse, path);
    switch (at.kind) {
      case "missing":
        throw browserFileStat.refuse("missing", `Nothing at ${path}`);
      case "folder":
        return { entry: folderEntry(at.name), read: "readable" };
      case "in-root": {
        if (at.path === "") {
          return {
            entry: folderEntry(at.root.spec.dir.split("/")[1]!),
            read: "readable",
          };
        }
        const stat = await at.root.stat(at.path);
        if (stat.kind === "missing") {
          throw browserFileStat.refuse("missing", `Nothing at ${path}`);
        }
        return { entry: entryOf(stat.entry), read: "readable" };
      }
    }
  },
  whileSubscribed: ({ path }, notify) => watchPath(path, () => notify()),
});

/** How many leading bytes the binary sniff reads — git's and host-fs's heuristic. */
const SNIFF_BYTES = 8000;

/** A file of the browser's file system as bytes, after the size gate. */
async function fileBytesAt(
  refuse: (
    code: "invalid-path" | "missing" | "not-a-file" | "too-large",
    message: string,
  ) => Error,
  path: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const at = locateOrRefuse(refuse, path);
  if (at.kind === "missing") throw refuse("missing", `Nothing at ${path}`);
  if (at.kind === "folder" || at.path === "") {
    throw refuse("not-a-file", `${path} is a folder`);
  }
  const stat = await at.root.stat(at.path);
  if (stat.kind === "missing") throw refuse("missing", `Nothing at ${path}`);
  if (stat.entry.kind !== "file")
    throw refuse("not-a-file", `${path} is a folder`);
  // Gated before the read: a huge file is never pulled into memory.
  if (stat.entry.size > maxBytes) {
    throw refuse(
      "too-large",
      `${nameOf(at.path)} is ${stat.entry.size} bytes, over the ${maxBytes}-byte limit`,
    );
  }
  const read = await at.root.read(at.path);
  if (read.kind === "missing") throw refuse("missing", `Nothing at ${path}`);
  const bytes = new Uint8Array(await read.blob.arrayBuffer());
  if (bytes.length > maxBytes) {
    throw refuse(
      "too-large",
      `${nameOf(at.path)} is ${bytes.length} bytes, over the ${maxBytes}-byte limit`,
    );
  }
  return bytes;
}

/** A file of the browser's file system as UTF-8 text, capped and binary-sniffed. */
export const browserFileTextServed = serveValue(browserFileText, {
  source: "external",
  changes: "notified",
  loader: async ({ path }): Promise<FileText> => {
    const bytes = await fileBytesAt(
      browserFileText.refuse,
      path,
      FILE_TEXT_MAX_BYTES,
    );
    if (bytes.subarray(0, SNIFF_BYTES).includes(0)) {
      throw browserFileText.refuse("binary", `${path} is a binary file`);
    }
    return { content: new TextDecoder().decode(bytes), size: bytes.length };
  },
  whileSubscribed: ({ path }, notify) => watchPath(path, () => notify()),
});

/** A file of the browser's file system as bytes, on demand. */
export const browserFileBytesServed = serveValue(browserFileBytes, {
  source: "external",
  changes: "notified",
  loader: async ({ path }): Promise<ArrayBuffer> => {
    const bytes = await fileBytesAt(
      browserFileBytes.refuse,
      path,
      FILE_BYTES_MAX,
    );
    const own = new Uint8Array(bytes.byteLength);
    own.set(bytes);
    return own.buffer;
  },
  whileSubscribed: ({ path }, notify) => watchPath(path, () => notify()),
});

// ── raw ──────────────────────────────────────────────────────────────────────

/**
 * `GET /api/files/browser/raw?path=` — a file of the browser's file system,
 * verbatim. Inert as the computer's raw route is: never sniffed, never able to
 * run script as the app (`sandbox`, a PDF excepted — its viewer refuses a
 * sandboxed document), never embeddable by another site.
 */
export async function handleBrowserFileRaw(req: Request): Promise<Response> {
  const path = new URL(req.url, "http://localhost").searchParams.get("path");
  if (path === null) return new Response("missing path", { status: 400 });
  let at: Located;
  try {
    at = locate(path);
  } catch (err) {
    if (err instanceof InvalidBrowserPath) {
      return new Response("invalid path", { status: 400 });
    }
    throw err;
  }
  if (at.kind !== "in-root" || at.path === "") {
    return new Response("not found", { status: 404 });
  }
  // A folder is not a file to serve (a root's `read` of one throws).
  const stat = await at.root.stat(at.path);
  if (stat.kind === "missing" || stat.entry.kind !== "file") {
    return new Response("not found", { status: 404 });
  }
  const read = await at.root.read(at.path);
  if (read.kind === "missing")
    return new Response("not found", { status: 404 });
  const name = nameOf(at.path);
  const contentType = contentTypeOf(name);
  return new Response(read.blob, {
    headers: {
      "content-type": contentType,
      "content-length": String(read.blob.size),
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
