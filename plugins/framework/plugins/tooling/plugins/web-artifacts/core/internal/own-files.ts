// Own-file enumeration + the stat-fingerprint fast path. A plugin's artifact
// hash covers exactly its OWN inlined source set — and that set is NOT a table
// written here: the roots ARE `inlinedRootsFor(kind)` (`../own-roots`), the one
// list the bundler's inline decision reads too, plus `package.json`. Hashing
// anything less than what the bytes inline fossilises the artifact; hashing
// more only forces spurious rebuilds. The lone special case is `entry`
// (web-core's own `web/` dir, no plugin around it).
//
// Nested sub-plugins live under `<dir>/plugins/` — never an inlined root — so a
// child's change never touches the parent's hash.
//
// One addition the roots cannot express: a literal `import.meta.glob` inlines
// whatever its pattern matches, which may sit outside the plugin (the bundled
// migrations' `data/*.sql` in their parent plugin, the repo's `/config/**`).
// Each such pattern's static base is a GLOB ROOT: its files join the address
// (`ownHashFor`) and the inline audit's allowed roots, so a new or changed file
// there re-addresses the artifact that inlines it — and only that one.
//
// Every file list and content id comes from the build's repo snapshot
// (`RepoSnapshot`): no directory walk, no stat, no read of a file to learn
// whether it changed. A file outside the snapshot — gitignored, or written
// after it was taken — is in no address; the inline audit fails a build that
// bundles one. The one content fact an address needs beyond ids, each module's
// `import.meta.glob` patterns, is memoized by blob id (`GlobPatternMemo`), so
// only an edited module is ever read.

import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  RepoFiles,
  RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import {
  isTestCodePath,
  TESTS_DIR,
  TESTING_FOLDER,
} from "@plugins/framework/plugins/plugin-id/core";
import { computeBlobListHash, sha256Hex } from "../hash";
import { inlinedRootsFor, type ArtifactKind } from "../own-roots";
import type { GlobPatternMemo } from "./store";

/** What an address is read off: the build's repo snapshot and the glob memo. */
export interface OwnSources {
  snapshot: RepoSnapshot;
  globs: GlobPatternMemo;
}

const SKIP_DIRS = new Set([
  "node_modules",
  TESTS_DIR,
  TESTING_FOLDER,
  "public",
]);

// What the address leaves out, stated once in `isHashedFile`: the listing
// filters by it and the inline audit's roots read the same rule. A test-code folder sits INSIDE a hashed
// root (`web/testing/`), so "inside a root" alone is not "hashed".
function isSkippedDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name === "dist" || name.startsWith("dist.");
}
function isSkippedFile(name: string): boolean {
  return isTestCodePath([name]) || name === ".DS_Store";
}

/**
 * The absolute dirs an artifact of `kind` hashes — and, by construction, the
 * only dirs its bytes may inline from. Shared by `listOwnFiles` (which lists
 * them) and the build-time inline audit (which checks containment against
 * them), so the address and its assertion cannot drift.
 */
export function hashedRootsFor(
  pluginDir: string,
  kind: ArtifactKind,
): string[] {
  return kind === "entry"
    ? [pluginDir] // entry: web-core/web dir itself, no plugin folders around it
    : inlinedRootsFor(kind).map((root) => join(pluginDir, root));
}

/**
 * Whether `abs` is one of the files the address hashes: inside one of `roots`
 * (`hashedRootsFor`) and not left out by the walk's skip rules — test code,
 * `node_modules`, `public`, build output. `listOwnFiles` filters the
 * snapshot by it.
 */
export function isHashedFile(roots: readonly string[], abs: string): boolean {
  for (const root of roots) {
    if (!abs.startsWith(root + sep)) continue;
    const segments = abs.slice(root.length + 1).split(sep);
    const name = segments.pop()!;
    if (!segments.some(isSkippedDir) && !isSkippedFile(name)) return true;
  }
  return false;
}

/**
 * Absolute paths of the artifact's own files, sorted: the snapshot's files in
 * the kind's hashed roots that `isHashedFile` keeps, plus the plugin's
 * `package.json`.
 */
export function listOwnFiles(
  repo: RepoFiles,
  pluginDir: string,
  kind: ArtifactKind,
): string[] {
  const out: string[] = [];
  for (const root of hashedRootsFor(pluginDir, kind)) {
    for (const rel of repo.under(relative(repo.root, root))) {
      const abs = join(repo.root, rel);
      if (isHashedFile([root], abs)) out.push(abs);
    }
  }
  if (kind !== "entry") {
    const pkg = join(pluginDir, "package.json");
    if (repo.has(relative(repo.root, pkg))) out.push(pkg);
  }
  out.sort();
  return out;
}

/** `files` (absolute, under `baseDir`) hashed by content id. */
function blobHashOf(
  snapshot: RepoSnapshot,
  baseDir: string,
  files: readonly string[],
): string {
  return computeBlobListHash(
    files.map((abs) => ({
      rel: relative(baseDir, abs),
      blob: snapshot.blobOf(relative(snapshot.root, abs)),
    })),
  );
}

// `import.meta.glob(` with an optional type argument; what follows decides
// whether the pattern is a literal the address can list.
const GLOB_CALL_RE = /import\.meta\.glob\s*(?:<[^>()]*>)?\s*\(\s*/g;
const STRING_LITERAL_RE = /^(["'])((?:(?!\1)[^\\\n])*)\1/;
const GLOB_META_RE = /[*?{}[\]!]/;

/**
 * Every `import.meta.glob` pattern of one module's source, as written. A
 * pattern that is not one string literal throws, naming the module: vite
 * requires literals, and an address cannot list what it cannot read.
 */
function globPatternsOf(moduleRel: string, source: string): string[] {
  if (!source.includes("import.meta.glob")) return [];
  const patterns: string[] = [];
  for (const m of source.matchAll(GLOB_CALL_RE)) {
    const rest = source.slice(m.index + m[0].length);
    const lit = STRING_LITERAL_RE.exec(rest);
    if (lit === null) {
      throw new Error(
        `${moduleRel}: import.meta.glob takes one string-literal pattern here (an artifact's address lists its static base)`,
      );
    }
    patterns.push(lit[2]!);
  }
  return patterns;
}

/**
 * A pattern's repo-relative static base: the path segments before the first
 * holding a glob metacharacter, resolved against the module's directory (or
 * the repo root, for a root-absolute pattern — vite's root is the repo).
 */
function globRootOfPattern(
  root: string,
  moduleRel: string,
  pattern: string,
): string {
  const segments = pattern.split("/");
  const metaAt = segments.findIndex((seg) => GLOB_META_RE.test(seg));
  const staticPart = segments
    .slice(0, metaAt < 0 ? segments.length - 1 : metaAt)
    .join("/");
  const abs = pattern.startsWith("/")
    ? join(root, staticPart)
    : resolve(root, dirname(moduleRel), staticPart);
  const rel = relative(root, abs).split(sep).join("/");
  if (rel.startsWith("..")) {
    throw new Error(
      `${moduleRel}: import.meta.glob pattern "${pattern}" reaches outside the repo`,
    );
  }
  return rel === "" ? "." : rel;
}

/**
 * The repo-relative static bases of every `import.meta.glob` pattern in one
 * module's source (`globPatternsOf`, `globRootOfPattern`).
 */
export function globRootsOf(
  root: string,
  moduleRel: string,
  source: string,
): string[] {
  return globPatternsOf(moduleRel, source).map((p) =>
    globRootOfPattern(root, moduleRel, p),
  );
}

// A glob root this wide would make one artifact's address the whole repo.
const TOO_WIDE_GLOB_ROOTS = new Set([".", "plugins"]);

const MODULE_RE = /\.[cm]?[jt]sx?$/;

/**
 * The repo-relative glob roots of `files`' modules, deduped and sorted. Each
 * module's patterns come from the memo by blob id; only a blob never seen is
 * read (and recorded).
 */
async function globRootsOfFiles(
  sources: OwnSources,
  files: readonly string[],
): Promise<string[]> {
  const { snapshot, globs } = sources;
  const roots = new Set<string>();
  await Promise.all(
    files
      .filter((abs) => MODULE_RE.test(abs))
      .map(async (abs) => {
        const rel = relative(snapshot.root, abs).split(sep).join("/");
        const blob = snapshot.blobOf(rel);
        let patterns = globs.get(blob);
        if (patterns === undefined) {
          const text = await snapshot.read(rel);
          if (text === null) {
            throw new Error(
              `${rel}: in the repo snapshot but gone from disk while its address was planned`,
            );
          }
          patterns = globPatternsOf(rel, text);
          globs.set(blob, patterns);
        }
        for (const pattern of patterns) {
          const g = globRootOfPattern(snapshot.root, rel, pattern);
          if (TOO_WIDE_GLOB_ROOTS.has(g)) {
            throw new Error(
              `${rel}: import.meta.glob's static base "${g}" is the whole ${g === "." ? "repo" : "plugin tree"} — narrow the pattern`,
            );
          }
          roots.add(g);
        }
      }),
  );
  return [...roots].sort();
}

/**
 * The repo-relative files under every glob root `modules` (repo-relative
 * module paths) declare, sorted — what those modules would inline, and what a
 * process reading the same data off disk reads (a crawl take's disk swaps for
 * the bundled providers). Each module's patterns come from the memo.
 */
export async function globFilesOfModules(
  sources: OwnSources,
  modules: Iterable<string>,
): Promise<string[]> {
  const { snapshot } = sources;
  const roots = await globRootsOfFiles(
    sources,
    [...modules].map((rel) => join(snapshot.root, rel)),
  );
  const files = new Set<string>();
  for (const rel of roots) {
    const abs = join(snapshot.root, rel);
    for (const p of snapshot.under(rel))
      if (isHashedFile([abs], join(snapshot.root, p))) files.add(p);
  }
  return [...files].sort();
}

/** One artifact's address inputs, as `ownHashFor` read them off the snapshot. */
export interface OwnAddress {
  ownHash: string;
  /** Absolute glob roots: the inline audit allows exactly them beside the own roots. */
  globRoots: string[];
  /**
   * Absolute paths of every file the address hashed — own files and glob-root
   * files. What the inline audit holds the bundle to, and what the builder
   * scans for Tailwind candidates (the own ones), so neither lists again.
   */
  ownFiles: string[];
  globFiles: string[];
}

/**
 * The artifact's own address: its own files' content ids
 * (`listOwnFiles`), plus — for each glob root those files declare — the ids
 * of every file under it. Reads no file but a module whose glob patterns the
 * memo has not seen.
 */
export async function ownHashFor(opts: {
  pluginDir: string;
  kind: ArtifactKind;
  sources: OwnSources;
}): Promise<OwnAddress> {
  const { snapshot } = opts.sources;
  const repoRoot = snapshot.root;
  const ownFiles = listOwnFiles(snapshot, opts.pluginDir, opts.kind);
  const ownHash = blobHashOf(snapshot, opts.pluginDir, ownFiles);
  const globRoots = await globRootsOfFiles(opts.sources, ownFiles);
  if (globRoots.length === 0) {
    return { ownHash, globRoots: [], ownFiles, globFiles: [] };
  }
  const parts = [ownHash];
  const globFiles: string[] = [];
  for (const rel of globRoots) {
    const abs = join(repoRoot, rel);
    const under = snapshot
      .under(rel)
      .map((p) => join(repoRoot, p))
      .filter((p) => isHashedFile([abs], p));
    parts.push(`${rel}\t${blobHashOf(snapshot, repoRoot, under)}`);
    globFiles.push(...under);
  }
  return {
    ownHash: sha256Hex(parts.join("\n")),
    globRoots: globRoots.map((rel) => join(repoRoot, rel)),
    ownFiles,
    globFiles,
  };
}
