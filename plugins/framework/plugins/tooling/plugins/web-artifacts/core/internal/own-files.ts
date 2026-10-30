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
// All I/O here is async (`node:fs/promises`) behind a small shared concurrency
// gate. This module runs on the check runner's ONE shared thread (as well as
// inside `./equin build`), and a fleet-wide hash pass touches thousands
// of small source files — a blocking `readdirSync`/`statSync`/`readFileSync`
// holds that thread for every OTHER check in the pass too (checks/CLAUDE.md's
// stall watch). The gate bounds fan-out (never one `Promise.all` per file
// across a whole fleet) without serializing reads one at a time.

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  isTestCodePath,
  TESTS_DIR,
  TESTING_FOLDER,
} from "@plugins/framework/plugins/plugin-id/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { computeOwnHash, sha256Hex, type OwnFile } from "../hash";
import { inlinedRootsFor, type ArtifactKind } from "../own-roots";
import type { FingerprintCache, FingerprintRecord } from "./store";

const SKIP_DIRS = new Set([
  "node_modules",
  TESTS_DIR,
  TESTING_FOLDER,
  "public",
]);

// What the walk leaves out of the address, stated once: `walkFiles` applies it
// while walking, and `isHashedFile` applies it to one path, so the inline audit
// asks exactly what the address hashed. A test-code folder sits INSIDE a hashed
// root (`web/testing/`), so "inside a root" alone is not "hashed".
function isSkippedDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name === "dist" || name.startsWith("dist.");
}
function isSkippedFile(name: string): boolean {
  return isTestCodePath([name]) || name === ".DS_Store";
}

// Bounds concurrent file-system calls FROM THIS MODULE. Only the leaf I/O
// calls (one `readdir` per directory, one `stat`/`readFile` per file) take a
// slot — NEVER a recursive `walkFiles` call itself, which would hold a slot
// for its whole subtree and could starve the very `readdir` calls it's
// waiting on (the nested-semaphore deadlock class documented in
// checks/CLAUDE.md's fan-out section, and the one host-read-pool hit before).
const IO_CONCURRENCY = 32;
const ioGate = createSemaphore(IO_CONCURRENCY);
function withIoSlot<T>(fn: () => Promise<T>): Promise<T> {
  return ioGate.run(fn);
}

async function walkFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await withIoSlot(() => readdir(dir, { withFileTypes: true }));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    return;
  }
  const subdirs: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (isSkippedDir(e.name)) continue;
      subdirs.push(p);
    } else if (e.isFile()) {
      if (isSkippedFile(e.name)) continue;
      out.push(p);
    }
  }
  // Order doesn't matter: `listOwnFiles` sorts the aggregate result, so
  // sibling subdirectories can walk concurrently (through the shared gate).
  await Promise.all(subdirs.map((p) => walkFiles(p, out)));
}

/**
 * The absolute dirs an artifact of `kind` hashes — and, by construction, the
 * only dirs its bytes may inline from. Shared by `listOwnFiles` (which walks
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
 * `node_modules`, `public`, build output. The path-shaped twin of the walk in
 * `listOwnFiles` (symlinks aside, which only a directory read can see); the
 * inline audit checks every bundled module against it.
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

/** Absolute paths of the artifact's own files, sorted. */
export async function listOwnFiles(
  pluginDir: string,
  kind: ArtifactKind,
): Promise<string[]> {
  const roots = hashedRootsFor(pluginDir, kind);
  const out: string[] = [];
  await Promise.all(roots.map((root) => walkFiles(root, out)));
  if (kind !== "entry") {
    const pkg = join(pluginDir, "package.json");
    try {
      await withIoSlot(() => stat(pkg));
      out.push(pkg);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  out.sort();
  return out;
}

/**
 * Read `files` as (rel, content) pairs via `toEntry`, bounded by the same IO
 * gate as the walk — reading a whole own-file set opens many files at once and
 * unbounded concurrency here would exhaust file descriptors. Shared by
 * `identity.ts`'s `builderSourceDigest` (no fingerprint cache of its own).
 */
export async function readFilesBounded<T>(
  files: string[],
  toEntry: (abs: string, content: Buffer) => T,
): Promise<T[]> {
  return Promise.all(
    files.map(async (abs) =>
      toEntry(abs, await withIoSlot(() => readFile(abs))),
    ),
  );
}

/**
 * Aggregate content hash of an explicit file list, via the fingerprint fast
 * path: when the (mtimeMs, size) of every file matches the cached record, the
 * recorded hash is reused without reading content. Any mismatch (or a changed
 * file SET) re-reads and re-hashes, then updates the record in place. A file
 * that vanishes between listing and stat/read contributes nothing (transient —
 * e.g. a tracked-but-deleted path); any other IO error surfaces.
 */
export async function cachedAggregateHash(opts: {
  cacheKey: string;
  /** Hash keys are paths relative to this dir, so renames invalidate. */
  baseDir: string;
  files: string[];
  cache: FingerprintCache;
  /**
   * Record the files' glob roots (`globRootsOf`) on a rewritten record, from
   * the contents this read already holds, resolved against this repo root.
   */
  globRootsFrom?: string;
}): Promise<string> {
  const stats: Array<{
    abs: string;
    rel: string;
    mtimeMs: number;
    size: number;
  }> = [];
  await Promise.all(
    opts.files.map(async (f) => {
      let st;
      try {
        st = await withIoSlot(() => stat(f));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        return;
      }
      if (!st.isFile()) return;
      stats.push({
        abs: f,
        rel: relative(opts.baseDir, f),
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    }),
  );

  const record = opts.cache.records[opts.cacheKey];
  if (record && Object.keys(record.files).length === stats.length) {
    let clean = true;
    for (const s of stats) {
      const fp = record.files[s.rel];
      if (!fp || fp[0] !== s.mtimeMs || fp[1] !== s.size) {
        clean = false;
        break;
      }
    }
    if (clean) return record.ownHash;
  }

  const contents: OwnFile[] = [];
  await Promise.all(
    stats.map(async (s) => {
      try {
        contents.push({
          rel: s.rel,
          content: await withIoSlot(() => readFile(s.abs)),
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }),
  );
  const ownHash = computeOwnHash(contents);
  const next: FingerprintRecord = { files: {}, ownHash };
  if (opts.globRootsFrom !== undefined) {
    next.globRoots = globRootsOfContents(
      opts.globRootsFrom,
      contents.map((c) => ({
        abs: join(opts.baseDir, c.rel),
        source: c.content,
      })),
    );
  }
  for (const s of stats) next.files[s.rel] = [s.mtimeMs, s.size];
  opts.cache.records[opts.cacheKey] = next;
  return ownHash;
}

// `import.meta.glob(` with an optional type argument; what follows decides
// whether the pattern is a literal the address can list.
const GLOB_CALL_RE = /import\.meta\.glob\s*(?:<[^>()]*>)?\s*\(\s*/g;
const STRING_LITERAL_RE = /^(["'])((?:(?!\1)[^\\\n])*)\1/;
const GLOB_META_RE = /[*?{}[\]!]/;

/**
 * The repo-relative static bases of every `import.meta.glob` pattern in one
 * module's source: the path segments before the first holding a glob
 * metacharacter, resolved against the module's directory (or the repo root,
 * for a root-absolute pattern — vite's root is the repo). A pattern that is not
 * one string literal throws, naming the module: vite requires literals, and an
 * address cannot list what it cannot read.
 */
export function globRootsOf(
  root: string,
  moduleRel: string,
  source: string,
): string[] {
  const roots: string[] = [];
  for (const m of source.matchAll(GLOB_CALL_RE)) {
    const rest = source.slice(m.index + m[0].length);
    const lit = STRING_LITERAL_RE.exec(rest);
    if (lit === null) {
      throw new Error(
        `${moduleRel}: import.meta.glob takes one string-literal pattern here (an artifact's address lists its static base)`,
      );
    }
    const pattern = lit[2]!;
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
    roots.push(rel === "" ? "." : rel);
  }
  return roots;
}

// A glob root this wide would make one artifact's address the whole repo.
const TOO_WIDE_GLOB_ROOTS = new Set([".", "plugins"]);

/** The repo-relative glob roots of these modules' sources, deduped and sorted. */
function globRootsOfContents(
  repoRoot: string,
  modules: ReadonlyArray<{ abs: string; source: string | Uint8Array }>,
): string[] {
  const roots = new Set<string>();
  for (const { abs, source } of modules) {
    if (!/\.[cm]?[jt]sx?$/.test(abs)) continue;
    const text =
      typeof source === "string" ? source : new TextDecoder().decode(source);
    if (!text.includes("import.meta.glob")) continue;
    const rel = relative(repoRoot, abs).split(sep).join("/");
    for (const g of globRootsOf(repoRoot, rel, text)) {
      if (TOO_WIDE_GLOB_ROOTS.has(g)) {
        throw new Error(
          `${rel}: import.meta.glob's static base "${g}" is the whole ${g === "." ? "repo" : "plugin tree"} — narrow the pattern`,
        );
      }
      roots.add(g);
    }
  }
  return [...roots].sort();
}

/**
 * The glob roots of `files`, as recorded on their fingerprint record: computed
 * from the contents `cachedAggregateHash` read when it (re)wrote the record,
 * so a record on the stat fast path costs nothing. A record written before
 * glob roots were recorded is read once and completed.
 */
async function globRootsRecorded(opts: {
  cacheKey: string;
  repoRoot: string;
  files: string[];
  cache: FingerprintCache;
}): Promise<string[]> {
  const record = opts.cache.records[opts.cacheKey];
  if (record === undefined) {
    throw new Error(`glob roots: no fingerprint record for ${opts.cacheKey}`);
  }
  if (record.globRoots !== undefined) return record.globRoots;
  const modules = await Promise.all(
    opts.files
      .filter((f) => /\.[cm]?[jt]sx?$/.test(f))
      .map(async (abs) => ({
        abs,
        source: await withIoSlot(() => readFile(abs, "utf8")),
      })),
  );
  record.globRoots = globRootsOfContents(opts.repoRoot, modules);
  return record.globRoots;
}

/**
 * The artifact's own address: `cachedAggregateHash` over the kind's own-file
 * roots, plus — for each glob root those files declare — the content of every
 * file under it (each root's own fingerprint record, shared by every artifact
 * globbing it). Returns the absolute glob roots too: the inline audit allows
 * exactly them beside the own roots.
 */
export async function ownHashFor(opts: {
  cacheKey: string;
  pluginDir: string;
  kind: ArtifactKind;
  cache: FingerprintCache;
  repoRoot: string;
}): Promise<{ ownHash: string; globRoots: string[] }> {
  const files = await listOwnFiles(opts.pluginDir, opts.kind);
  const ownHash = await cachedAggregateHash({
    cacheKey: opts.cacheKey,
    baseDir: opts.pluginDir,
    files,
    cache: opts.cache,
    globRootsFrom: opts.repoRoot,
  });
  const globRoots = await globRootsRecorded({
    cacheKey: opts.cacheKey,
    repoRoot: opts.repoRoot,
    files,
    cache: opts.cache,
  });
  if (globRoots.length === 0) return { ownHash, globRoots: [] };
  const parts = [ownHash];
  for (const rel of globRoots) {
    const abs = join(opts.repoRoot, rel);
    const under: string[] = [];
    await walkFiles(abs, under);
    under.sort();
    parts.push(
      `${rel}\t${await cachedAggregateHash({
        cacheKey: `glob|${rel}`,
        baseDir: opts.repoRoot,
        files: under,
        cache: opts.cache,
      })}`,
    );
  }
  return {
    ownHash: sha256Hex(parts.join("\n")),
    globRoots: globRoots.map((rel) => join(opts.repoRoot, rel)),
  };
}
