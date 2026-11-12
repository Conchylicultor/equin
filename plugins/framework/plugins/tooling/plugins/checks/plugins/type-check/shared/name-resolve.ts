// Module resolution for the two-program type check, keyed on what it PROBED.
//
// A file's resolutions are part of what its stored record says: which repo
// files its imports land on. They move when a file appears that shadows one
// (`foo.ts` beside `foo/index.ts`), when a directory starts to exist, or when a
// `package.json` (an `exports` map) changes. Re-resolving every import of every
// file each run costs seconds (~44k resolutions); so each resolution is
// recorded with what it looked at:
//
//   - the repo PROBES it made — each lookup of `dir/x.ts` and each existence
//     test of `dir/x` is the probe `dir/x`: the NAME STEM `x` in `dir`. A probe
//     inside a directory that does not exist is the probe of that directory's
//     first missing segment in its NEAREST EXISTING ANCESTOR, the entry whose
//     creation would change the answer;
//   - the repo FILES it read (a `package.json`).
//
// and a file's resolution key is the hash of each probe's ANSWER — the
// entries of its directory sharing its stem (`x`, `x.ts`, `x.d.ts`, `x/`) —
// and those files' versions, all read from the check's VIEW of
// the repo (`./repo-view.ts`): the run's git tree. An untracked-not-ignored
// file is in the tree and shadows like a tracked one; anything else on disk —
// a gitignored file included — does not exist for the check.
// It used to be the real `readdir` listing, so the transient gitignored entries
// of the repo root (`.install.lock`, `.merge_file_*`, `.check-*`) — which every
// lookup that walks up to the root's `node_modules` reached — moved ~6,000
// files' keys after unrelated commands, and made the verdict a function of
// files the check's key never hashed.
//
// Until 2026-11-04 a probe was the WHOLE listing of its directory: a file added
// beside a hub's barrel (a `CLAUDE.md` in `web-sdk/core/`) moved the key of
// every file importing it — 1,516 entries rewritten by a run that checked
// nothing, and rewritten back by the next worktree on the other listing (one
// type-check wrote 5,059 record files in 30 s, each lstat-ed ~17× by
// fseventsd). A stem is what TypeScript asks about, so only an entry that can
// shadow, or start or stop resolving, an import moves a key.
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
  /**
   * The probes that decide them (`probeOf`), sorted: `dir/stem`, or `dir/*`
   * for a directory whose whole listing was asked for.
   */
  probes: string[];
  /** Repo files whose content decides them, sorted. */
  files: string[];
  /** The hash of those listings and contents when recorded. */
  key: string;
}

/** A probe asking for a directory's whole listing (`getDirectories`). */
const LISTING = "*";

const parentOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};

const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/**
 * The stem of a directory entry's name: up to its first dot past the first
 * character (`x.d.ts`, `x.ts` and `x/` are all `x`; `.eslintrc.json` is
 * `.eslintrc`). Every name TypeScript tries for one specifier shares it.
 */
export function stemOf(name: string): string {
  const i = name.indexOf(".", 1);
  return i < 0 ? name : name.slice(0, i);
}

/** The probe asking for `dir`'s whole listing (`getDirectories`). */
export function listingProbe(dir: string): string {
  return dir === "" ? LISTING : `${dir}/${LISTING}`;
}

/** The probe naming entry `path`'s stem in its directory. */
export function probeOf(path: string): string {
  const dir = parentOf(path);
  const stem = stemOf(baseOf(path));
  return dir === "" ? stem : `${dir}/${stem}`;
}

/**
 * The view as resolution keys it, memoized for one run: directory listings,
 * each probe's answer and file versions by repo-relative path.
 */
export class ProbeFs {
  private readonly listings = new Map<string, string | null>();
  private readonly stems = new Map<string, Map<string, string>>();
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

  /**
   * The probe a question about `path` (does it exist, as a file or a
   * directory) is: its stem in its directory, or — that directory missing —
   * the first missing segment's stem in the nearest existing ancestor.
   */
  probe(path: string): string {
    const dir = parentOf(path);
    const at = this.existing(dir);
    if (at === dir) return probeOf(path);
    const below = path.slice(at === "" ? 0 : at.length + 1);
    const seg = below.slice(0, below.indexOf("/"));
    return probeOf(at === "" ? seg : `${at}/${seg}`);
  }

  /**
   * A probe's answer: the entries of its directory sharing its stem, each
   * marked file or directory — empty when there are none, or no directory
   * (both answer every question about the stem "absent").
   */
  answer(probe: string): string {
    const dir = parentOf(probe);
    const stem = baseOf(probe);
    if (stem === LISTING) return this.listing(dir) ?? "-";
    let byStem = this.stems.get(dir);
    if (byStem === undefined) {
      byStem = new Map();
      if (this.view.isDir(dir)) {
        const e = this.view.entries(dir);
        const add = (name: string, mark: string): void => {
          const s = stemOf(name);
          const prev = byStem!.get(s);
          byStem!.set(
            s,
            prev === undefined ? name + mark : `${prev}\n${name}${mark}`,
          );
        };
        for (const f of [...e.files].sort()) add(f, "");
        for (const d of [...e.dirs].sort()) add(d, "/");
      }
      this.stems.set(dir, byStem);
    }
    return byStem.get(stem) ?? "";
  }

  /** A read file's version, or `-` when it is not in the view. */
  content(file: string): string {
    return this.view.version(file) ?? "-";
  }

  /** The key of a set of probes and read files, as they are now. */
  key(probes: readonly string[], files: readonly string[]): string {
    return sha(
      [
        ...probes.map((p) => `p\0${p}\0${this.answer(p)}`),
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
    { target: Target; probes: Set<string>; files: Set<string> }
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
  ): { target: Target; probes: Set<string>; files: Set<string> } {
    const k = `${fromDir}\0${specifier}\0${mode}`;
    const hit = this.memo.get(k);
    if (hit !== undefined) return hit;
    const root = this.fs.root;
    const sys = this.sys;
    const probes = new Set<string>();
    const files = new Set<string>();
    // Whether `abs` exists (as a file or a directory): its stem's probe.
    const probe = (abs: string): void => {
      const r = rel(root, abs);
      if (r !== "" && isRepoPath(r)) probes.add(this.fs.probe(r));
    };
    // Every in-repo question answered by the view, and recorded; one about a
    // path outside the repo (`node_modules`) answered by the disk and recorded
    // nowhere — not even as its parent's listing, which no longer decides it.
    const host: ts.ModuleResolutionHost = {
      fileExists: (f) => {
        probe(f);
        return sys.fileExists(f);
      },
      directoryExists: (d) => {
        probe(d);
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
        const r = rel(root, d);
        if (isRepoPath(r)) probes.add(listingProbe(r));
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
    const out = { target, probes, files };
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
    const probes = new Set<string>();
    const files = new Set<string>();
    const seen = new Set<string>();
    for (const [spec, mode] of specifiers) {
      const k = `${spec}\0${mode}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const r = this.resolveOne(fromDir, spec, mode);
      targets.push([spec, mode, r.target]);
      for (const p of r.probes) probes.add(p);
      for (const f of r.files) files.add(f);
    }
    targets.sort((a, b) => (`${a[0]}\0${a[1]}` < `${b[0]}\0${b[1]}` ? -1 : 1));
    const p = [...probes].sort();
    const f = [...files].sort();
    return { targets, probes: p, files: f, key: this.fs.key(p, f) };
  }
}

/** Whether a recorded resolution still holds in the view as it is now. */
export function resolutionHolds(fs: ProbeFs, rec: ResolutionRecord): boolean {
  return fs.key(rec.probes, rec.files) === rec.key;
}
