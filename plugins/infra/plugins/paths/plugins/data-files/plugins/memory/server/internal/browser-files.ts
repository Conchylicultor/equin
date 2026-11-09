import { serveValue, sliceRange } from "@plugins/network/plugins/live/server";
import type { LiveKeyRange } from "@plugins/network/plugins/live/core";
import { createRefcountHub } from "@plugins/packages/plugins/refcount-hub/core";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import {
  originOf,
  type WriteOrigin,
} from "@plugins/infra/plugins/request-origin/core";
import {
  InvalidRelPathError,
  isWithinRel,
  joinRel,
  parseRelPath,
  relName,
  relParent,
  type DataChange,
  type FileData,
  type FileEntry as StoreEntry,
  type Mount as StoreOps,
  type RelPath,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import {
  listFileRoots,
  type FileRoot,
  type FileRootSpec,
  type FileRootStore,
  type WatchedFileRoot,
} from "@plugins/infra/plugins/paths/plugins/data-files/server";
import {
  FILE_BYTES_MAX,
  FILE_PEEK_MAX_NAMES,
  FILE_TEXT_MAX_BYTES,
  browserDirPeek,
  browserFileBytes,
  browserFileListing,
  browserFileMove,
  browserFileStat,
  browserFileText,
  contentTypeOf,
  type FileDirPeek,
  type FileEntry,
  type FileListingMeta,
  type FileMoveOutcome,
  type FileMoveResolution,
  type FileMoveResult,
  type FileStat,
  type FileText,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { DATA_FOLDER } from "./home-layout";
import { memoryDataFiles } from "./memory-store";

// The browser's file system (`{ fs: "browser" }`): this host's storage laid out
// like a home folder, so a reader names a file by a path and never by which
// app keeps it. `~` is its root. The apps' folders sit where the desktop keeps
// them, under the hidden `~/.equin/` — each declared file root at its data dir
// (`~/.equin/apps/prototypes/…`), the folders above a root implied by the
// roots there are. Everything else — `~/Documents`, whatever a person keeps —
// is the home's own tree, which the provider keeps beside the roots' (same
// store, same persistence). Served only by a browser host (this plugin is
// never booted on the desktop, where the same folders are on the computer's
// disk).

/**
 * The home's own tree, kept by this provider like a root's: everything of `~`
 * outside the hidden data folder. Not a declared root — nobody's data dir,
 * never bound on the desktop — so only this file system reaches it, on this
 * host's own store (the one it provides as `DataFiles`).
 */
const HOME: FileRootSpec = {
  id: "browser-files.home",
  dir: "apps/.home",
  watch: {
    name: "browser-files-home.tree",
    description:
      "Hears every change to the browser's home folder so Files' listings and open files follow it.",
  },
};

/** The home's tree, on this host's store. */
function homeStore(): FileRootStore {
  return memoryDataFiles.root(HOME);
}

/**
 * A tree a path lands in — a declared root's folder, or the home's own tree —
 * with the key its watch is shared under.
 */
interface Mount {
  /** The hub key: the root's id, or the home's. */
  id: string;
  /** Where the mount's own folder is, as a `~` path. */
  at: string;
  store: StoreOps;
  /** A root's files are its app's: they are read here, never moved. */
  app: boolean;
  /** The tree's watch; `null` for a root declared without one (a cache). */
  watch: FileRootStore["watch"] | null;
}

function rootMount(root: FileRoot): Mount {
  return {
    id: root.id,
    at: `~/${DATA_FOLDER}/${root.spec.dir}`,
    store: root,
    app: true,
    watch:
      "watch" in root
        ? (onChange) => (root as WatchedFileRoot).watch(onChange)
        : null,
  };
}

function homeMount(): Mount {
  const store = homeStore();
  return {
    id: HOME.id,
    at: "~",
    store,
    app: false,
    watch: (onChange) => store.watch(onChange),
  };
}

/** Where a path of the browser's file system lands. */
type Located =
  | {
      /** A folder above the roots (`~/.equin`, `~/.equin/apps`): its children are implied. */
      kind: "implied";
      path: string;
      children: string[];
    }
  | { kind: "mount"; mount: Mount; path: RelPath }
  | { kind: "missing"; path: string };

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

/** A path's canonical spelling: `~`, or `~/a/b`. */
function spell(segments: readonly string[]): string {
  return segments.length === 0 ? "~" : `~/${segments.join("/")}`;
}

/** The folder holding a canonical path; `null` for `~`. */
function parentOf(path: string): string | null {
  if (path === "~") return null;
  const cut = path.lastIndexOf("/");
  return cut <= 1 ? "~" : path.slice(0, cut);
}

/** The distinct next segments of the roots' data dirs below `prefix` (`""`, `apps`). */
function impliedChildren(prefix: string): string[] {
  const names = new Set<string>();
  for (const root of listFileRoots()) {
    const dir = root.spec.dir;
    if (prefix === "") names.add(dir.split("/")[0]!);
    else if (dir.startsWith(`${prefix}/`)) {
      names.add(dir.slice(prefix.length + 1).split("/")[0]!);
    }
  }
  return [...names].sort();
}

function toRel(segments: readonly string[]): RelPath {
  try {
    return parseRelPath(segments.join("/"));
  } catch (err) {
    if (err instanceof InvalidRelPathError) {
      throw new InvalidBrowserPath(err.message);
    }
    throw err;
  }
}

/** Where `path` lands: a folder the roots imply, a path in a root or in the home, or nothing. */
function locate(path: string): Located {
  const segments = segmentsOf(path);
  const spelled = spell(segments);
  if (segments[0] !== DATA_FOLDER) {
    return { kind: "mount", mount: homeMount(), path: toRel(segments) };
  }
  const below = segments.slice(1);
  // A data dir is `${kind}/${name}`: the two segments under ~/.equin.
  if (below.length < 2) {
    const children = impliedChildren(below.join("/"));
    if (children.length === 0) return { kind: "missing", path: spelled };
    return { kind: "implied", path: spelled, children };
  }
  const dir = `${below[0]}/${below[1]}`;
  const root = listFileRoots().find((r) => r.spec.dir === dir);
  if (root === undefined) return { kind: "missing", path: spelled };
  return { kind: "mount", mount: rootMount(root), path: toRel(below.slice(2)) };
}

/** A mount's path as a `~` path. */
function spellIn(mount: Mount, path: RelPath): string {
  if (path === "") return mount.at;
  return mount.at === "~" ? `~/${path}` : `${mount.at}/${path}`;
}

/** A store's entry, as every file system's. */
function entryOf(entry: StoreEntry, name = entry.name): FileEntry {
  return {
    name,
    kind: entry.kind,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    birthtimeMs: entry.birthtimeMs,
    hidden: name.startsWith("."),
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

/** The last segment of a canonical path (`~` for home). */
function baseOf(path: string): string {
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

/** The mount a hub key names. */
function mountOf(id: string): Mount | null {
  if (id === HOME.id) return homeMount();
  const root = listFileRoots().find((r) => r.id === id);
  return root === undefined ? null : rootMount(root);
}

/** Each watched mount's changes, one watch per mount while anything reads it. */
const mountChanges = createRefcountHub<DataChange>(async (id, emit) => {
  const mount = mountOf(id);
  if (mount === null || mount.watch === null) {
    throw new Error(`[data-files] no watched tree "${id}" to watch`);
  }
  const watch = await mount.watch((change) => emit(change));
  return () => watch.dispose();
});

/**
 * Hear the changes that may move what a read of `path` shows, until the stop
 * runs: a change at, below or above it in its tree. A folder above every
 * root moves only with a build; a root declared without a watch (a cache) is
 * never pushed — its readers see it as of their read.
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
  if (at.kind !== "mount" || at.mount.watch === null) return () => {};
  const within = at.path;
  const hold = mountChanges.acquire(at.mount.id, (change) => {
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

// ── folders ──────────────────────────────────────────────────────────────────

type FolderRefuse = (
  code: "invalid-path" | "missing" | "not-a-dir",
  message: string,
) => Error;

/** A folder's entries in code-point name order, or the refusal saying why there are none. */
async function folderEntries(
  refuse: FolderRefuse,
  path: string,
): Promise<{ path: string; entries: FileEntry[] }> {
  const at = locateOrRefuse(refuse, path);
  switch (at.kind) {
    case "missing":
      throw refuse("missing", `Nothing at ${at.path}`);
    case "implied":
      return { path: at.path, entries: at.children.map(folderEntry) };
    case "mount": {
      const spelled = spellIn(at.mount, at.path);
      const listed = await at.mount.store.list(at.path);
      let entries: FileEntry[];
      if (listed.kind === "missing") {
        // A mount's own folder is there before anything is written into it.
        if (at.path !== "") throw refuse("missing", `Nothing at ${spelled}`);
        entries = [];
      } else {
        entries = listed.entries.map((e) => entryOf(e));
      }
      // Home holds the hidden data folder beside its own entries.
      if (!at.mount.app && at.path === "" && impliedChildren("").length > 0) {
        entries = [...entries, folderEntry(DATA_FOLDER)].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        );
      }
      return { path: spelled, entries };
    }
  }
}

/** A list read whose path is a file, refused as one. */
async function refuseIfFile(
  refuse: FolderRefuse,
  path: string,
): Promise<never | void> {
  const at = locateOrRefuse(refuse, path);
  if (at.kind !== "mount" || at.path === "") return;
  const stat = await at.mount.store.stat(at.path);
  if (stat.kind === "found" && stat.entry.kind === "file") {
    throw refuse("not-a-dir", `${spellIn(at.mount, at.path)} is not a folder`);
  }
}

/** One page of a folder of the browser's file system: its range of the entries. */
export async function browserListingPage(
  q: { path: string },
  range: LiveKeyRange,
): Promise<FileEntry[]> {
  await refuseIfFile(browserFileListing.refuse, q.path);
  const { entries } = await folderEntries(browserFileListing.refuse, q.path);
  return sliceRange(browserFileListing, entries, range);
}

/** What a folder of the browser's file system says about itself (the meta sibling). */
export async function browserListingMeta(q: {
  path: string;
}): Promise<FileListingMeta> {
  await refuseIfFile(browserFileListing.refuse, q.path);
  const { path, entries } = await folderEntries(
    browserFileListing.refuse,
    q.path,
  );
  return { path, parent: parentOf(path), total: entries.length };
}

/** A folder of the browser's file system, its entries paged by name. */
export const browserFileListingServed = serveValue(browserFileListing, {
  source: "external",
  changes: "notified",
  loader: browserListingPage,
  meta: browserListingMeta,
  whileSubscribed: (q, notify) => watchPath(q.path, () => notify()),
});

/** A folder of the browser's file system, by child name only. */
export const browserDirPeekServed = serveValue(browserDirPeek, {
  source: "external",
  changes: "notified",
  loader: async ({ path }): Promise<FileDirPeek> => {
    await refuseIfFile(browserDirPeek.refuse, path);
    const listed = await folderEntries(browserDirPeek.refuse, path);
    if (listed.entries.length > FILE_PEEK_MAX_NAMES) {
      return {
        kind: "too-many",
        path: listed.path,
        total: listed.entries.length,
      };
    }
    return {
      kind: "ok",
      path: listed.path,
      children: listed.entries.map((e) => ({ name: e.name, hidden: e.hidden })),
    };
  },
  whileSubscribed: ({ path }, notify) => watchPath(path, () => notify()),
});

// ── reads ────────────────────────────────────────────────────────────────────

/** One path of the browser's file system described. */
export const browserFileStatServed = serveValue(browserFileStat, {
  source: "external",
  changes: "notified",
  loader: async ({ path }): Promise<FileStat> => {
    const at = locateOrRefuse(browserFileStat.refuse, path);
    switch (at.kind) {
      case "missing":
        throw browserFileStat.refuse("missing", `Nothing at ${at.path}`);
      case "implied":
        return {
          path: at.path,
          parent: parentOf(at.path),
          entry: folderEntry(baseOf(at.path)),
          read: "readable",
        };
      case "mount": {
        const spelled = spellIn(at.mount, at.path);
        const described = {
          path: spelled,
          parent: parentOf(spelled),
          read: "readable",
        } as const;
        if (at.path === "") {
          return { ...described, entry: folderEntry(baseOf(spelled)) };
        }
        const stat = await at.mount.store.stat(at.path);
        if (stat.kind === "missing") {
          throw browserFileStat.refuse("missing", `Nothing at ${spelled}`);
        }
        return { ...described, entry: entryOf(stat.entry, relName(at.path)) };
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
  if (at.kind === "missing") throw refuse("missing", `Nothing at ${at.path}`);
  if (at.kind === "implied" || at.path === "") {
    throw refuse("not-a-file", `${path} is a folder`);
  }
  const { store } = at.mount;
  const stat = await store.stat(at.path);
  if (stat.kind === "missing") throw refuse("missing", `Nothing at ${path}`);
  if (stat.entry.kind !== "file")
    throw refuse("not-a-file", `${path} is a folder`);
  // Gated before the read: a huge file is never pulled into memory.
  if (stat.entry.size > maxBytes) {
    throw refuse(
      "too-large",
      `${relName(at.path)} is ${stat.entry.size} bytes, over the ${maxBytes}-byte limit`,
    );
  }
  const read = await store.read(at.path);
  if (read.kind === "missing") throw refuse("missing", `Nothing at ${path}`);
  const bytes = new Uint8Array(await read.blob.arrayBuffer());
  if (bytes.length > maxBytes) {
    throw refuse(
      "too-large",
      `${relName(at.path)} is ${bytes.length} bytes, over the ${maxBytes}-byte limit`,
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
  if (at.kind !== "mount" || at.path === "") {
    return new Response("not found", { status: 404 });
  }
  const { store } = at.mount;
  // A folder is not a file to serve (a store's `read` of one throws).
  const stat = await store.stat(at.path);
  if (stat.kind === "missing" || stat.entry.kind !== "file") {
    return new Response("not found", { status: 404 });
  }
  const read = await store.read(at.path);
  if (read.kind === "missing")
    return new Response("not found", { status: 404 });
  const name = relName(at.path);
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

// ── move ─────────────────────────────────────────────────────────────────────

/** Where `path` lands, or `null` when it is no path of this system. */
function locateOrNull(path: string): Located | null {
  try {
    return locate(path);
  } catch (err) {
    if (err instanceof InvalidBrowserPath) return null;
    throw err;
  }
}

/** The Finder's next free name for `name` in `dir` (`a 2.txt`). */
async function freeName(
  store: StoreOps,
  dir: RelPath,
  name: string,
  isFile: boolean,
): Promise<RelPath> {
  const dot = isFile ? name.lastIndexOf(".") : -1;
  const ext = dot > 0 ? name.slice(dot) : "";
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = joinRel(dir, `${stem} ${n}${ext}`);
    if ((await store.stat(candidate)).kind === "missing") return candidate;
  }
}

/**
 * Move paths of the browser's home into one of its folders, the Finder's
 * way (as the computer's move): never replacing unless asked, a folder never
 * into itself. The apps' folders under `~/.equin/` are the apps' to keep — a
 * source or destination there is refused (`archive`, "kept by the system").
 */
export async function moveBrowserFiles(
  sources: readonly string[],
  destDir: string,
  resolutions: Readonly<Record<string, FileMoveResolution>>,
  writer: WriteOrigin,
): Promise<FileMoveResult> {
  const dest = locateOrNull(destDir);
  if (dest === null) return { kind: "missing", path: destDir };
  if (dest.kind === "missing") return { kind: "missing", path: dest.path };
  if (dest.kind === "implied" || dest.mount.app) {
    return {
      kind: "archive",
      path:
        dest.kind === "implied" ? dest.path : spellIn(dest.mount, dest.path),
    };
  }
  const { store } = dest.mount;
  const destPath = dest.path;
  const destSpelled = spellIn(dest.mount, destPath);
  if (destPath !== "") {
    const stat = await store.stat(destPath);
    if (stat.kind === "missing") return { kind: "missing", path: destSpelled };
    if (stat.entry.kind !== "dir") {
      return { kind: "not-a-dir", path: destSpelled };
    }
  }
  const results: FileMoveOutcome[] = [];
  for (const raw of sources) {
    // A spelling that is no path names nothing to move: that source alone
    // answers so, after the ones before it moved.
    const at = locateOrNull(raw);
    if (at === null) {
      results.push({ kind: "missing", from: raw });
      continue;
    }
    if (at.kind !== "mount" || at.mount.app || at.path === "") {
      results.push(
        at.kind === "missing"
          ? { kind: "missing", from: at.path }
          : { kind: "archive", from: raw },
      );
      continue;
    }
    const from = at.path;
    const fromSpelled = spellIn(at.mount, from);
    const stat = await store.stat(from);
    if (stat.kind === "missing") {
      results.push({ kind: "missing", from: fromSpelled });
      continue;
    }
    if (relParent(from) === destPath) {
      results.push({ kind: "same-dir", from: fromSpelled });
      continue;
    }
    if (isWithinRel(destPath, from)) {
      results.push({ kind: "into-self", from: fromSpelled });
      continue;
    }
    let to = joinRel(destPath, relName(from));
    const taken = (await store.stat(to)).kind === "found";
    if (taken) {
      const resolution = resolutions[raw] ?? resolutions[fromSpelled];
      if (resolution === undefined) {
        results.push({
          kind: "exists",
          from: fromSpelled,
          to: spellIn(at.mount, to),
        });
        continue;
      }
      if (resolution === "skip") {
        results.push({ kind: "skipped", from: fromSpelled });
        continue;
      }
      if (resolution === "keep-both") {
        to = await freeName(
          store,
          destPath,
          relName(from),
          stat.entry.kind === "file",
        );
      } else {
        if (isWithinRel(from, to)) {
          results.push({
            kind: "replaces-ancestor",
            from: fromSpelled,
            to: spellIn(at.mount, to),
          });
          continue;
        }
        // The taken entry is set aside, not removed, until the source is in
        // its place: a move that fails leaves it where it was.
        const aside = await freeName(
          store,
          destPath,
          `.${relName(to)}.replaced`,
          false,
        );
        if ((await store.rename(to, aside, { writer })) !== "renamed") {
          results.push({ kind: "missing", from: fromSpelled });
          continue;
        }
        const placed = await store.rename(from, to, { writer });
        if (placed !== "renamed") {
          await store.rename(aside, to, { writer });
          results.push({ kind: "missing", from: fromSpelled });
          continue;
        }
        await store.remove(aside, { recursive: true, writer });
        results.push({
          kind: "moved",
          from: fromSpelled,
          to: spellIn(at.mount, to),
        });
        continue;
      }
    }
    const renamed = await store.rename(from, to, { writer });
    results.push(
      renamed === "renamed"
        ? { kind: "moved", from: fromSpelled, to: spellIn(at.mount, to) }
        : renamed === "missing"
          ? { kind: "missing", from: fromSpelled }
          : { kind: "exists", from: fromSpelled, to: spellIn(at.mount, to) },
    );
  }
  return { kind: "ok", destDir: destSpelled, results };
}

/** `POST /api/files/browser/move`. */
export const handleBrowserFileMove = implement(
  browserFileMove,
  ({ body, req }) =>
    moveBrowserFiles(
      body.sources,
      body.destDir,
      body.resolutions ?? {},
      originOf(req),
    ),
);

// ── writes from a seed ───────────────────────────────────────────────────────

/**
 * Files of the browser's home as a fixture: a `~` path (`~/Documents/a.md`)
 * → its bytes or text. Folders are what the paths imply.
 */
export type BrowserHomeFixture = Readonly<Record<string, FileData>>;

/**
 * Write a fixture into the browser's home (a demo's seed, a test) through the
 * home's own writes — what a listing shows is pushed from the same watch.
 * Refuses an empty fixture, a path outside the home's own tree (under the
 * apps' hidden folder) and a path that is not one.
 */
export async function writeBrowserHomeFiles(
  fixture: BrowserHomeFixture,
  writer: WriteOrigin,
): Promise<void> {
  const entries = Object.entries(fixture);
  if (entries.length === 0) {
    throw new Error("browser home fixture: no files to write");
  }
  for (const [path, data] of entries) {
    const at = locate(path);
    if (at.kind !== "mount" || at.mount.app || at.path === "") {
      throw new Error(
        `browser home fixture: ${JSON.stringify(path)} is not a file of the home's own tree`,
      );
    }
    await at.mount.store.write(at.path, data, { writer });
  }
}
