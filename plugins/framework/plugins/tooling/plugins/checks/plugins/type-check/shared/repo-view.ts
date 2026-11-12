// The type check's INPUT: the run's git tree, and the one view of the repo
// every part of the check reads it through.
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
// THE TREE ONLY. A gitignored file does not exist for the check, even under
// the tsconfig `include`: the per-composition `*.composition.*.generated.ts`
// registries are build output, rewritten by any `./equin build` of the
// checkout — so a check that read them (they were once an "overlay" beside the
// tree) gave a verdict that was not a function of its tree, and died whenever
// a build rewrote one mid-run (the daily backstop on main, 2026-11-09 and
// -11). The root tsconfig `exclude`s them too, so an editor's program agrees.
//
// Outside the repo — `node_modules` (anywhere), anything above the root — the
// real filesystem answers: dependencies are pinned by the lockfile, which is in
// the engine (`./tsc-engine.ts`).
//
// A file's BYTES are its blob's, by construction: `readText` answers the
// content its version names, never "whatever is on disk now". The disk is only
// a fast way to the same bytes — read, hashed, and used when they hash to the
// version; otherwise (the file was edited, or a push advanced the checkout,
// after the tree was taken) the blob is read out of git's object store, where
// `computeTreeHash` already wrote it. So the working tree moving under a run
// changes nothing the run reads: the verdict is a function of its tree, and a
// long run on a live checkout (the daily backstop on main, killed by a push's
// merge on 2026-11-12) no longer dies of it. A blob missing from the store
// throws — the tree names content git does not hold.

import { createHash } from "crypto";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { dirname, relative } from "path";
import ts from "typescript";
import { readTreeSnapshot } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import type { GitTreeSnapshot } from "@plugins/framework/plugins/tooling/core";
// Through the barrel: the worker imports it the same way.
import type { TypeCheckTree } from "../core";
import { isRepoPath } from "./keys";
import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

const rel = (root: string, abs: string): string =>
  relative(root, abs).split("\\").join("/");

/** A directory's immediate entries, by name, sorted. */
export interface DirEntries {
  files: readonly string[];
  dirs: readonly string[];
}

/** The repo as the check sees it: the git tree. In memory, but `readText`. */
export interface RepoView {
  readonly root: AppPath;
  readonly treeHash: string;
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
   * A file's text: the bytes of its blob (off the disk when they still hash to
   * its version, else out of the object store). Throws when the file is not in
   * the view, or the object store does not hold its blob.
   */
  readText(path: string): string;
}

/**
 * Where a blob's bytes come from by sha: git's object store. Synchronous —
 * `readText` answers a TypeScript `CompilerHost`, which is.
 */
export type BlobSource = (sha: string) => Uint8Array;

/**
 * An object store holding exactly `texts` (each under its blob sha in a tree of
 * `treeHash`'s format): a fixture's tree, without a repository.
 */
export function blobSourceOf(
  texts: Iterable<string>,
  treeHash: string,
): BlobSource {
  const held = new Map<string, Uint8Array>();
  for (const text of texts) {
    const bytes = Buffer.from(text);
    held.set(gitBlobSha(bytes, treeHash), bytes);
  }
  return (sha) => {
    const bytes = held.get(sha);
    if (bytes === undefined) throw new Error(`no blob ${sha} in the fixture`);
    return bytes;
  };
}

/** `root`'s object store: `git cat-file blob <sha>`, one spawn per blob. */
export function gitBlobSource(root: AppPath): BlobSource {
  return (sha) => {
    const proc = Bun.spawnSync(["git", "cat-file", "blob", sha], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `type-check: git's object store in ${root} does not hold blob ${sha} (git cat-file exit ${proc.exitCode}: ${proc.stderr.toString().trim()})`,
      );
    }
    return proc.stdout;
  };
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

/** A file's bytes, or null when no file is there (any other error throws). */
function readIfPresent(abs: AppPath): Uint8Array | null {
  try {
    return readFileSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
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
 * A view over `blobs` (repo path → blob sha), whose bytes `objects` holds. Pure:
 * the tree comes from the caller — `openRepoView` reads it out of git; a test
 * hands it a fixture's.
 */
export function repoViewOver(
  root: AppPath,
  treeHash: string,
  blobs: ReadonlyMap<string, string>,
  objects: BlobSource,
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
          `type-check: ${path} is not in the checked tree ${treeHash}`,
        );
      }
      // The disk, when it still holds the blob (a missing file is a moved
      // tree too); the object store otherwise — checked all the same.
      const onDisk = readIfPresent(joinAppPath(root, path));
      if (onDisk !== null && gitBlobSha(onDisk, treeHash) === version) {
        return decode(onDisk);
      }
      const stored = objects(version);
      if (gitBlobSha(stored, treeHash) !== version) {
        throw new Error(
          `type-check: the object store answered blob ${version} (${path}) with bytes that do not hash to it`,
        );
      }
      return decode(stored);
    },
  };
}

/** The view of a git snapshot. */
export function viewOfSnapshot(snapshot: GitTreeSnapshot): RepoView {
  const blobs = new Map<string, string>();
  for (const p of snapshot.paths()) blobs.set(p, snapshot.blobSha(p)!);
  return repoViewOver(
    snapshot.root,
    snapshot.treeHash,
    blobs,
    gitBlobSource(snapshot.root),
  );
}

/** The view of `tree` over `root`: its snapshot, read out of git. */
export async function openRepoView(
  root: AppPath,
  tree: TypeCheckTree,
): Promise<RepoView> {
  return viewOfSnapshot(await readTreeSnapshot(root, tree.treeHash));
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
    // A symlink in the tree is a blob holding its target's path, and the view
    // reads it as that blob, never the file it points at: a repo path is its
    // own real path.
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
  root: AppPath,
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
 * The tsconfig parsed over the view — its `include` expanded over the tree's
 * listing, never the disk: what the preparation's coverage gate reads and the
 * worker builds its programs from, so both sides see the same roots.
 */
export function parseTsconfigOver(
  view: RepoView,
  tsconfigPath: string,
): ParsedTsconfig {
  const sys = viewSys(view);
  return parseTsconfig(
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
}

/** The check's input, read: the tree, the view over it, and the roots. */
export interface ReadCheckTree {
  tree: TypeCheckTree;
  view: RepoView;
  /** The tsconfig's include-expansion over the tree — or why there is none. */
  config: ParsedTsconfig;
}

/**
 * Read the check's input once: the snapshot of `treeHash` (the run's; the
 * working tree as `computeTreeHash` writes it when omitted), and the
 * tsconfig's include expanded over it.
 */
export async function readCheckTree(
  root: AppPath,
  tsconfigPath: string,
  treeHash?: string,
): Promise<ReadCheckTree> {
  const view = viewOfSnapshot(await readTreeSnapshot(root, treeHash));
  const config = parseTsconfigOver(view, tsconfigPath);
  return { tree: { treeHash: view.treeHash }, view, config };
}
