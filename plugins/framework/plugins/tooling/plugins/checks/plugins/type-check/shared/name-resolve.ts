// Module resolution for the two-program type check, keyed on what it PROBED.
//
// A file's resolutions are part of what its stored record says: which repo
// files its imports land on. They move when a file appears that shadows one
// (`foo.ts` beside `foo/index.ts`), when a directory starts to exist, or when a
// `package.json` (an `exports` map) changes. Re-resolving every import of every
// file each run costs seconds (~44k resolutions); so each resolution is
// recorded with what it looked at:
//
//   - the repo DIRECTORIES it probed — each lookup of `dir/x.ts` and each
//     existence test of `dir/x` counts `dir`; a directory that does not exist
//     counts its NEAREST EXISTING ANCESTOR, whose listing changes when it is
//     created;
//   - the repo FILES it read (a `package.json`).
//
// and a file's resolution key is the hash of those directories' listings
// (names only) and those files' versions — all read from the check's VIEW of
// the repo (`./repo-view.ts`): the run's git tree plus its overlay. An
// untracked-not-ignored file is in the tree and shadows like a tracked one; a
// gitignored file that is a program root (a composition registry) is in the
// overlay and shadows too; anything else on disk does not exist for the check.
// It used to be the real `readdir` listing, so the transient gitignored entries
// of the repo root (`.install.lock`, `.merge_file_*`, `.check-*`) — which every
// lookup that walks up to the root's `node_modules` reached — moved ~6,000
// files' keys after unrelated commands, and made the verdict a function of
// files the check's key never hashed.
//
// While the key holds, the recorded targets stand without a TypeScript call;
// when it moves, that file's imports are resolved again. Paths under
// `node_modules` are answered by the real filesystem and recorded nowhere —
// whether a `node_modules` exists, and what it holds, is pinned by the lockfile,
// which is in the engine.

import { createHash } from "crypto";
import { dirname, join, relative } from "path";
import ts from "typescript";
import { isRepoPath } from "./keys";
import { viewSys, type RepoView, type ViewSys } from "./repo-view";

const sha = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 32);

const rel = (root: string, abs: string): string =>
  relative(root, abs).split("\\").join("/");

/** Where one specifier landed: a repo path, `<dep>`, or `-` (unresolved). */
export type Target = string;

/** One file's resolutions and what they probed. */
export interface ResolutionRecord {
  /** [specifier, mode (-1: none), target], sorted. */
  targets: [string, number, Target][];
  /** Repo directories whose listing decides them (existing ones), sorted. */
  dirs: string[];
  /** Repo files whose content decides them, sorted. */
  files: string[];
  /** The hash of those listings and contents when recorded. */
  key: string;
}

/**
 * The view as resolution keys it, memoized for one run: directory listings and
 * file versions by repo-relative path.
 */
export class ProbeFs {
  private readonly listings = new Map<string, string | null>();
  constructor(readonly view: RepoView) {}

  get root(): string {
    return this.view.root;
  }

  /** A directory's listing hash, or null when it does not exist. */
  listing(dir: string): string | null {
    let v = this.listings.get(dir);
    if (v !== undefined) return v;
    if (!this.view.isDir(dir)) v = null;
    else {
      const e = this.view.entries(dir);
      v = sha([...e.files, ...e.dirs].sort().join("\n"));
    }
    this.listings.set(dir, v);
    return v;
  }

  /** The nearest existing directory at or above `dir` (repo-relative; "" is the root). */
  existing(dir: string): string {
    let d = dir;
    while (d !== "" && d !== "." && this.listing(d) === null) {
      const up = dirname(d);
      d = up === "." ? "" : up;
    }
    return d === "." ? "" : d;
  }

  /** A read file's version, or `-` when it is not in the view. */
  content(file: string): string {
    return this.view.version(file) ?? "-";
  }

  /** The key of a set of probed directories and read files, as they are now. */
  key(dirs: readonly string[], files: readonly string[]): string {
    return sha(
      [
        ...dirs.map((d) => `d\0${d}\0${this.listing(d) ?? "-"}`),
        ...files.map((f) => `f\0${f}\0${this.content(f)}`),
      ].join("\n"),
    );
  }
}

/**
 * Resolves module specifiers like the program does (same options, the same
 * view), recording what each resolution probed. Memoized per (directory,
 * specifier, mode) for the run — every file of a directory resolves a
 * specifier the same way, through the same probes.
 */
export class RecordingResolver {
  private readonly memo = new Map<
    string,
    { target: Target; dirs: Set<string>; files: Set<string> }
  >();
  private readonly sys: ViewSys;
  constructor(
    private readonly fs: ProbeFs,
    private readonly options: ts.CompilerOptions,
  ) {
    this.sys = viewSys(fs.view);
  }

  private resolveOne(
    fromDir: string,
    specifier: string,
    mode: number,
  ): { target: Target; dirs: Set<string>; files: Set<string> } {
    const k = `${fromDir}\0${specifier}\0${mode}`;
    const hit = this.memo.get(k);
    if (hit !== undefined) return hit;
    const root = this.fs.root;
    const sys = this.sys;
    const dirs = new Set<string>();
    const files = new Set<string>();
    const probeDir = (abs: string): void => {
      const r = rel(root, abs);
      if (!isRepoPath(r)) return;
      dirs.add(this.fs.existing(r === "" ? "" : r));
    };
    // Every in-repo question answered by the view, and recorded; one about a
    // path outside the repo (`node_modules`) answered by the disk and recorded
    // nowhere — not even as its parent's listing, which no longer decides it.
    const host: ts.ModuleResolutionHost = {
      fileExists: (f) => {
        probeDir(dirname(f));
        return sys.fileExists(f);
      },
      directoryExists: (d) => {
        if (isRepoPath(rel(root, d))) {
          // Whether `d` exists is its parent's listing (or, missing, its
          // nearest existing ancestor's).
          probeDir(dirname(d));
          probeDir(d);
        }
        return sys.directoryExists(d);
      },
      readFile: (f) => {
        const r = rel(root, f);
        if (isRepoPath(r)) files.add(r);
        return sys.readFile(f);
      },
      realpath: sys.realpath,
      getCurrentDirectory: () => root,
      getDirectories: (d) => {
        probeDir(d);
        return sys.getDirectories(d);
      },
    };
    const r = ts.resolveModuleName(
      specifier,
      join(root, fromDir, "__probe__.ts"),
      this.options,
      host,
      undefined,
      undefined,
      mode === -1 ? undefined : (mode as ts.ResolutionMode),
    ).resolvedModule;
    let target: Target;
    if (r === undefined) target = "-";
    else {
      const p = rel(root, r.resolvedFileName);
      target = isRepoPath(p) ? p : "<dep>";
    }
    const out = { target, dirs, files };
    this.memo.set(k, out);
    return out;
  }

  /** Where one specifier lands from a repo file. */
  target(fromPath: string, specifier: string, mode: number): Target {
    const fromDir = dirname(fromPath) === "." ? "" : dirname(fromPath);
    return this.resolveOne(fromDir, specifier, mode).target;
  }

  /** Resolve a file's specifiers, with what they probed and the key over it. */
  record(
    fromPath: string,
    specifiers: readonly [string, number][],
  ): ResolutionRecord {
    const fromDir = dirname(fromPath) === "." ? "" : dirname(fromPath);
    const targets: [string, number, Target][] = [];
    const dirs = new Set<string>();
    const files = new Set<string>();
    const seen = new Set<string>();
    for (const [spec, mode] of specifiers) {
      const k = `${spec}\0${mode}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const r = this.resolveOne(fromDir, spec, mode);
      targets.push([spec, mode, r.target]);
      for (const d of r.dirs) dirs.add(d);
      for (const f of r.files) files.add(f);
    }
    targets.sort((a, b) => (`${a[0]}\0${a[1]}` < `${b[0]}\0${b[1]}` ? -1 : 1));
    const d = [...dirs].sort();
    const f = [...files].sort();
    return { targets, dirs: d, files: f, key: this.fs.key(d, f) };
  }
}

/** Whether a recorded resolution still holds in the view as it is now. */
export function resolutionHolds(fs: ProbeFs, rec: ResolutionRecord): boolean {
  return fs.key(rec.dirs, rec.files) === rec.key;
}
