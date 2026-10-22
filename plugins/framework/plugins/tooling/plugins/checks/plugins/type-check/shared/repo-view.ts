// The type check's INPUT: the run's git tree plus its OVERLAY, and the one view
// of the repo every part of the check reads it through.
//
// The check is `inputKeyed`: its verdict must be a function of the tree its key
// hashes. So what a file IS — its version — is its git BLOB SHA, read out of
// the tree (`git ls-tree`, O(changes) through git's index stat cache), never a
// hash of a re-read; and every in-repo question the program asks — does this
// file exist, what is in this directory, what does this `package.json` say — is
// answered from the same tree. What is on disk and not in it (transient root
// files: `.install.lock`, `.merge_file_*`, `.check-*`; build output; stale
// directories) does not exist for the check. Measured before: the repo root's
// transient entries moved ~6,000 files' resolution keys after unrelated
// commands (research/2026-10-21-global-type-check-prepare-follows-the-change.md).
//
// THE OVERLAY. Some program roots have no blob: the gitignored
// `*.composition.*.generated.ts` registries sit inside the tsconfig `include`,
// and tsc compiles them. So the input is the snapshot PLUS the gitignored files
// the tsconfig makes roots of — found by expanding the `include` over the tree
// and the ignored entries git lists (`git ls-files -o -i --directory`, one
// call), and versioned like every other file (the blob sha of their bytes).
// The overlay is small (a dozen registries) and crosses to the worker as data,
// so both sides key the same files.
//
// Outside the repo — `node_modules` (anywhere), anything above the root — the
// real filesystem answers: dependencies are pinned by the lockfile, which is in
// the engine (`./tsc-engine.ts`).
//
// Bytes are still read off the disk, but only CHECKED against the view: a file
// whose bytes no longer hash to its version changed after the tree was taken,
// and reading on would record a result under a key it does not belong to. That
// throws (`readText`).

import { createHash } from "crypto";
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative } from "path";
import ts from "typescript";
import { readTreeSnapshot } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import type { GitTreeSnapshot } from "@plugins/framework/plugins/tooling/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
// Through the barrel: the worker imports it the same way.
import type { TypeCheckTree } from "../core";
import { isRepoPath } from "./keys";

// A wedge-breaker for one metadata read, not a latency budget.
const GIT_TIMEOUT_MS = 60_000;

const rel = (root: string, abs: string): string =>
  relative(root, abs).split("\\").join("/");

/** A directory's immediate entries, by name, sorted. */
export interface DirEntries {
  files: readonly string[];
  dirs: readonly string[];
}

/** The repo as the check sees it: the tree ∪ the overlay. In memory, but `readText`. */
export interface RepoView {
  readonly root: string;
  readonly treeHash: string;
  /** The gitignored program roots, with their versions. */
  readonly overlay: Readonly<Record<string, string>>;
  /** Every file, repo-relative, sorted. */
  files(): readonly string[];
  /** A file's version — its git blob sha — or undefined when it is not in the view. */
  version(path: string): string | undefined;
  isFile(path: string): boolean;
  /** Whether a directory holds anything in the view; `""` is the root. */
  isDir(path: string): boolean;
  /** A directory's entries (files and subdirectories); empty when it is not one. */
  entries(dir: string): DirEntries;
  /**
   * A file's text off the disk, CHECKED against its version: throws when the
   * file is not in the view, or its bytes changed since the tree was taken.
   */
  readText(path: string): string;
}

/**
 * The blob sha git gives `bytes` (`git hash-object`, no filters): SHA-1, or
 * SHA-256 in a repository of that object format — told apart by the length of
 * the tree's own hash.
 */
export function gitBlobSha(bytes: Uint8Array, treeHash: string): string {
  const algo = treeHash.length === 64 ? "sha256" : "sha1";
  return createHash(algo)
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

/** UTF-8 text the way `ts.sys.readFile` decodes it: a leading BOM dropped. */
function decode(bytes: Uint8Array): string {
  const bom =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "utf8",
    bom ? 3 : 0,
  );
}

/**
 * A view over `blobs` (repo path → blob sha). Pure: the tree comes from the
 * caller — `openRepoView` reads it out of git; a test hands it a fixture's.
 */
export function repoViewOver(
  root: string,
  treeHash: string,
  blobs: ReadonlyMap<string, string>,
  overlay: Readonly<Record<string, string>> = {},
): RepoView {
  const index = new Map<string, { files: Set<string>; dirs: Set<string> }>();
  const at = (dir: string) => {
    let e = index.get(dir);
    if (e === undefined)
      index.set(dir, (e = { files: new Set(), dirs: new Set() }));
    return e;
  };
  for (const path of blobs.keys()) {
    const segs = path.split("/");
    let dir = "";
    for (let i = 0; i < segs.length - 1; i++) {
      at(dir).dirs.add(segs[i]!);
      dir = dir === "" ? segs[i]! : `${dir}/${segs[i]!}`;
    }
    at(dir).files.add(segs[segs.length - 1]!);
  }
  const sorted = new Map<string, DirEntries>();
  const none: DirEntries = { files: [], dirs: [] };
  const files: readonly string[] = Object.freeze([...blobs.keys()].sort());
  return {
    root,
    treeHash,
    overlay,
    files: () => files,
    version: (path) => blobs.get(path),
    isFile: (path) => blobs.has(path),
    isDir: (path) => path === "" || index.has(path),
    entries(dir) {
      let e = sorted.get(dir);
      if (e === undefined) {
        const raw = index.get(dir);
        e =
          raw === undefined
            ? none
            : { files: [...raw.files].sort(), dirs: [...raw.dirs].sort() };
        sorted.set(dir, e);
      }
      return e;
    },
    readText(path) {
      const version = blobs.get(path);
      if (version === undefined) {
        throw new Error(
          `type-check: ${path} is not in the checked tree ${treeHash} (nor its overlay)`,
        );
      }
      const bytes = readFileSync(join(root, path));
      if (gitBlobSha(bytes, treeHash) !== version) {
        throw new Error(
          `type-check: ${path} changed on disk after the check took its tree (${treeHash}) — its bytes no longer hash to its version. Re-run the check once the tree is quiet.`,
        );
      }
      return decode(bytes);
    },
  };
}

/** The view of a git snapshot plus an overlay. Throws when they overlap. */
export function viewOfSnapshot(
  snapshot: GitTreeSnapshot,
  overlay: Readonly<Record<string, string>>,
): RepoView {
  const blobs = new Map<string, string>();
  for (const p of snapshot.paths()) blobs.set(p, snapshot.blobSha(p)!);
  for (const [p, v] of Object.entries(overlay)) {
    if (blobs.has(p)) {
      throw new Error(
        `type-check: overlay file ${p} is also in the tree ${snapshot.treeHash} — the overlay is the gitignored files only`,
      );
    }
    blobs.set(p, v);
  }
  return repoViewOver(snapshot.root, snapshot.treeHash, blobs, overlay);
}

/** The view of `tree` over `root`: its snapshot, read out of git, plus its overlay. */
export async function openRepoView(
  root: string,
  tree: TypeCheckTree,
): Promise<RepoView> {
  return viewOfSnapshot(
    await readTreeSnapshot(root, tree.treeHash),
    tree.overlay,
  );
}

// ─── The filesystem, as the view answers it ────────────────────────────────

/** The in-repo half of `ts.System` a program and a resolution ask, from the view. */
export interface ViewSys {
  fileExists(abs: string): boolean;
  directoryExists(abs: string): boolean;
  readFile(abs: string): string | undefined;
  getDirectories(abs: string): string[];
  realpath(abs: string): string;
}

/**
 * `ts.sys`, with every question about a repo path answered by the view, and the
 * rest — `node_modules`, outside the root — by the real filesystem.
 */
export function viewSys(view: RepoView): ViewSys {
  const repo = (abs: string): string | null => {
    const r = rel(view.root, abs);
    return isRepoPath(r) ? r : null;
  };
  return {
    fileExists: (abs) => {
      const r = repo(abs);
      return r === null ? ts.sys.fileExists(abs) : view.isFile(r);
    },
    directoryExists: (abs) => {
      const r = repo(abs);
      return r === null ? ts.sys.directoryExists(abs) : view.isDir(r);
    },
    readFile: (abs) => {
      const r = repo(abs);
      if (r === null) return ts.sys.readFile(abs);
      return view.isFile(r) ? view.readText(r) : undefined;
    },
    getDirectories: (abs) => {
      const r = repo(abs);
      return r === null
        ? ts.sys.getDirectories(abs)
        : [...view.entries(r).dirs];
    },
    // No symlink is in the view (git stores one as a blob, which the view
    // reads as the file it points at only through `readText`'s disk read), so
    // a repo path is its own real path.
    realpath: (abs) =>
      repo(abs) === null ? (ts.sys.realpath?.(abs) ?? abs) : abs,
  };
}

/**
 * A CompilerHost over the view: repo files read through `readText` (checked
 * against their versions), repo existence from the view, the environment
 * (lib, `node_modules`) from TypeScript's own host.
 */
export function viewCompilerHost(
  view: RepoView,
  options: ts.CompilerOptions,
): ts.CompilerHost {
  const base = ts.createCompilerHost(options, /*setParentNodes*/ false);
  const sys = viewSys(view);
  return {
    ...base,
    fileExists: sys.fileExists,
    readFile: sys.readFile,
    directoryExists: sys.directoryExists,
    getDirectories: sys.getDirectories,
    realpath: sys.realpath,
    getSourceFile(fileName, languageVersionOrOptions, onError) {
      const r = rel(view.root, fileName);
      if (!isRepoPath(r)) {
        return base.getSourceFile(fileName, languageVersionOrOptions, onError);
      }
      if (!view.isFile(r)) return undefined;
      return ts.createSourceFile(
        fileName,
        view.readText(r),
        languageVersionOrOptions,
        /*setParentNodes*/ false,
      );
    },
  };
}

// ─── The tsconfig's roots, expanded over a listing ─────────────────────────

/** `ts.matchFiles`: the include/exclude expansion `ts.sys.readDirectory` runs. */
type MatchFiles = (
  path: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (path: string) => {
    files: readonly string[];
    directories: readonly string[];
  },
  realpath: (path: string) => string,
) => string[];

/**
 * TypeScript's own include/exclude matcher. Internal to the compiler (not in
 * its `.d.ts`), and used anyway: the roots must be EXACTLY what tsc expands —
 * its wildcard and dot-file rules, its exclude semantics — over a listing that
 * is not the filesystem. A compiler without it fails here, loudly, instead of
 * a hand-copy of its rules drifting.
 */
function matchFiles(): MatchFiles {
  const fn = (ts as unknown as { matchFiles?: unknown }).matchFiles;
  if (typeof fn !== "function") {
    throw new Error(
      `type-check: TypeScript ${ts.version} has no internal ts.matchFiles — the tsconfig include can no longer be expanded over the git tree; find its replacement`,
    );
  }
  return fn as MatchFiles;
}

/** The tsconfig parsed — or why it is not. */
export type ParsedTsconfig =
  | { kind: "parsed"; parsed: ts.ParsedCommandLine; roots: string[] }
  | { kind: "unreadable"; error: ts.Diagnostic };

/**
 * Parse `tsconfigPath` with its `include` expanded over `entries` (a repo
 * directory's listing) — never the filesystem — and the config files read
 * through `readFile`. `roots` are the include-expansion, repo-relative.
 */
function parseTsconfig(
  root: string,
  tsconfigPath: string,
  entries: (absDir: string) => {
    files: readonly string[];
    directories: readonly string[];
  },
  realpath: (abs: string) => string,
  fileExists: (abs: string) => boolean,
  readFile: (abs: string) => string | undefined,
): ParsedTsconfig {
  const cfg = ts.readConfigFile(tsconfigPath, readFile);
  if (cfg.error) return { kind: "unreadable", error: cfg.error };
  const match = matchFiles();
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: (dir, extensions, excludes, includes, depth) =>
      match(
        dir,
        extensions,
        excludes,
        includes,
        ts.sys.useCaseSensitiveFileNames,
        root,
        depth,
        entries,
        realpath,
      ),
    fileExists,
    readFile,
  };
  const parsed = ts.parseJsonConfigFileContent(
    cfg.config,
    host,
    // The config's own directory: every `include` / `exclude` pattern in it is
    // relative to the file, and the repo tsconfig sits at the repo root.
    dirname(tsconfigPath),
    undefined,
    tsconfigPath,
  );
  return {
    kind: "parsed",
    parsed,
    roots: parsed.fileNames.map((f) => rel(root, f)),
  };
}

/**
 * The tsconfig parsed over the view: what the worker builds its programs from.
 * Every overlay file must come out a root — the overlay was made of roots — or
 * the two sides disagree on the input, and that throws.
 */
export function parseTsconfigOver(
  view: RepoView,
  tsconfigPath: string,
): ParsedTsconfig {
  const sys = viewSys(view);
  const out = parseTsconfig(
    view.root,
    tsconfigPath,
    (abs) => {
      const r = rel(view.root, abs);
      if (!isRepoPath(r)) return { files: [], directories: [] };
      const e = view.entries(r);
      return { files: e.files, directories: e.dirs };
    },
    (abs) => abs,
    sys.fileExists,
    sys.readFile,
  );
  if (out.kind === "parsed") {
    const roots = new Set(out.roots);
    const stray = Object.keys(view.overlay).filter((p) => !roots.has(p));
    if (stray.length > 0) {
      throw new Error(
        `type-check: overlay file(s) ${stray.join(", ")} are not roots of ${tsconfigPath} — the overlay is the gitignored roots, and this parse disagrees with the one that made it`,
      );
    }
  }
  return out;
}

/** What git lists as ignored, at directory granularity (`--directory`). */
interface Ignored {
  files: ReadonlySet<string>;
  /** Wholly-ignored directories, never descended by git: no trailing `/`. */
  dirs: ReadonlySet<string>;
}

/**
 * Every ignored entry of the working tree, one `git ls-files` call. A wholly
 * ignored directory (`node_modules/`, `dist.live.*`, `.cache/`) is ONE entry
 * that git does not descend — what keeps this cheap — and is read further only
 * if the tsconfig expansion walks into it (`readCheckTree`).
 */
async function listIgnored(root: string): Promise<Ignored> {
  const out = await spawnCaptured(
    [
      "git",
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ],
    { cwd: root, timeoutMs: GIT_TIMEOUT_MS },
  );
  if (out.exitCode !== 0) {
    throw new Error(
      `type-check: git ls-files --others --ignored failed in ${root} (exit ${out.exitCode}): ${out.stderr.trim()}`,
    );
  }
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const entry of out.stdout.split("\0")) {
    if (entry === "") continue;
    if (entry.endsWith("/")) dirs.add(entry.slice(0, -1));
    else files.add(entry);
  }
  return { files, dirs };
}

/** A directory's entries on the real disk (inside an ignored directory). */
function diskEntries(abs: string): {
  files: readonly string[];
  directories: readonly string[];
} {
  const files: string[] = [];
  const directories: string[] = [];
  let dirents;
  try {
    dirents = readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { files, directories };
    throw err;
  }
  for (const d of dirents) {
    let isFile = d.isFile();
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try {
        const s = statSync(join(abs, d.name));
        isFile = s.isFile();
        isDir = s.isDirectory();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        continue; // a dangling link: tsc's own listing skips it too
      }
    }
    if (isFile) files.push(d.name);
    else if (isDir) directories.push(d.name);
  }
  return { files: files.sort(), directories: directories.sort() };
}

/** The check's input, read: the tree, its overlay, the view over both, and the roots. */
export interface ReadCheckTree {
  tree: TypeCheckTree;
  view: RepoView;
  /** The tsconfig's include-expansion over tree ∪ overlay — or why there is none. */
  config: ParsedTsconfig;
}

/**
 * Read the check's input once: the snapshot of `treeHash` (the run's), the
 * ignored entries git lists, and the tsconfig's include expanded over both —
 * whose roots without a blob ARE the overlay, versioned by their bytes.
 *
 * The expansion walks the tree's listing; on reaching an ignored directory the
 * tsconfig does not exclude (a stale plugin directory holding only
 * `node_modules`, say), it lists that one off the disk, as tsc would. An
 * excluded one (`node_modules`, `dist*`) and a dot-directory are never entered.
 */
export async function readCheckTree(
  root: string,
  tsconfigPath: string,
  treeHash?: string,
): Promise<ReadCheckTree> {
  const [snapshot, ignored] = await Promise.all([
    readTreeSnapshot(root, treeHash),
    listIgnored(root),
  ]);
  const tree = viewOfSnapshot(snapshot, {});
  const underIgnored = (r: string): boolean => {
    for (let d = r; d !== "" && d !== "."; d = dirname(d)) {
      if (ignored.dirs.has(d)) return true;
    }
    return false;
  };
  // The ignored entries by the directory they sit directly in.
  const ignoredIn = new Map<string, { files: string[]; dirs: string[] }>();
  const parentOf = (p: string): [string, string] => {
    const slash = p.lastIndexOf("/");
    return slash < 0 ? ["", p] : [p.slice(0, slash), p.slice(slash + 1)];
  };
  for (const [paths, kind] of [
    [ignored.files, "files"],
    [ignored.dirs, "dirs"],
  ] as const) {
    for (const p of paths) {
      const [dir, name] = parentOf(p);
      let e = ignoredIn.get(dir);
      if (e === undefined) ignoredIn.set(dir, (e = { files: [], dirs: [] }));
      e[kind].push(name);
    }
  }
  const entries = (abs: string) => {
    const r = rel(root, abs);
    if (!isRepoPath(r)) return { files: [], directories: [] };
    if (r !== "" && underIgnored(r)) return diskEntries(abs);
    const e = tree.entries(r);
    const extra = ignoredIn.get(r);
    if (extra === undefined) return { files: e.files, directories: e.dirs };
    return {
      files: [...e.files, ...extra.files],
      directories: [...e.dirs, ...extra.dirs],
    };
  };
  const sys = viewSys(tree);
  const config = parseTsconfig(
    root,
    tsconfigPath,
    entries,
    (abs) =>
      underIgnored(rel(root, abs)) ? (ts.sys.realpath?.(abs) ?? abs) : abs,
    sys.fileExists,
    sys.readFile,
  );
  const overlay: Record<string, string> = {};
  if (config.kind === "parsed") {
    for (const r of config.roots) {
      if (tree.isFile(r)) continue;
      overlay[r] = gitBlobSha(readFileSync(join(root, r)), snapshot.treeHash);
    }
  }
  const view = viewOfSnapshot(snapshot, overlay);
  return { tree: { treeHash: snapshot.treeHash, overlay }, view, config };
}
