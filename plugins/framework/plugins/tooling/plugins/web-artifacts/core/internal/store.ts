// Content-addressed artifact store at `~/.equin/cache/web-artifacts/`, shared
// across worktrees: a dir per artifact keyed by its inputs hash. Reuse bumps the
// dir's mtime; pruning (age + a count bound over unreferenced entries) runs
// under the store lock with build leases as roots — `lease.ts`.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { webArtifactsDir } from "../../data-dirs";
import { precompressDir } from "./precompress";

// Read off the declaration in this plugin's `data-dirs/index.ts` rather than
// joining the data root by hand. These stay module-level consts, exactly as
// they were when they read a frozen `EQUIN_DIR`: three sibling modules
// (`check/index.ts`, `vendors.ts`, `global-css.ts`) already join them into
// their own module-level consts, so the whole family freezes at first import
// either way. They become functions when the store actually moves off its
// `legacyLocation`, which is the point at which a stale read could differ.
export const WEB_ARTIFACTS_DIR = webArtifactsDir.path;
export const WEB_ARTIFACTS_STORE_DIR = webArtifactsDir.file("store");
const STORE_DIR = WEB_ARTIFACTS_STORE_DIR;
const FINGERPRINTS_DIR = webArtifactsDir.file("fingerprints");

// Pruning bounds. An artifact dir is small (one module + map); one build links
// ~1600 of them, so these bound the UNREFERENCED population only — an entry a
// dist links or a build lease pins is a root, never pruned and never counted
// (see `pruneCacheDir`). ~9,000 entries are referenced on a busy host.
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_UNREFERENCED = 8000;
const TRIM_TO = 6000;

/** Per-artifact metadata persisted next to `index.js`. */
export interface ArtifactMeta {
  /** The import-map specifier this artifact serves (null for entry/registry). */
  specifier: string | null;
  kind: string;
  pluginPath: string | null;
  inputsHash: string;
  /**
   * External static import specifiers PER EMITTED FILE (`index.js` plus any
   * code-split `.mjs` chunks). Per-file so the preload BFS walks real static
   * edges — a lazy chunk's dependencies must not be preloaded eagerly.
   */
  staticImportsByFile: Record<string, string[]>;
  /** External specifiers ANY emitted file dynamically imports (union). */
  dynamicImports: string[];
  /**
   * The Tailwind class candidates of the files this artifact's address hashed
   * (`tailwind-candidates.ts`), sorted. The global stylesheet is compiled from
   * their union over the composition. Empty for an artifact that ships no
   * page markup (the registry, a browser host).
   */
  tailwindCandidates: string[];
  builtAtMs: number;
}

/** Union of every emitted file's static imports (coverage / closure / vendors). */
export function allStaticImports(meta: ArtifactMeta): string[] {
  const specs = new Set<string>();
  for (const imports of Object.values(meta.staticImportsByFile)) {
    for (const s of imports) specs.add(s);
  }
  return [...specs].sort();
}

export function artifactDirName(
  slug: string,
  kind: string,
  inputsHash: string,
): string {
  return `${slug}.${kind}.${inputsHash.slice(0, 16)}`;
}

export function artifactStorePath(dirName: string): string {
  return join(STORE_DIR, dirName);
}

export function ensureStoreDirs(): void {
  mkdirSync(STORE_DIR, { recursive: true });
  mkdirSync(FINGERPRINTS_DIR, { recursive: true });
}

/** True iff the artifact completed publishing (meta.json is written last). */
export function hasArtifact(dirName: string): boolean {
  return existsSync(join(artifactStorePath(dirName), "meta.json"));
}

/**
 * Every complete artifact whose store name starts with `prefix`, most recently
 * used first (reuse bumps a dir's mtime — {@link touchArtifact}), ties by name.
 */
export function listArtifacts(prefix: string): string[] {
  let names: string[];
  try {
    names = readdirSync(STORE_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return [];
  }
  const found: { name: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !hasArtifact(name)) continue;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(artifactStorePath(name)).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      continue; // pruned underneath us
    }
    found.push({ name, mtimeMs });
  }
  found.sort((a, b) =>
    b.mtimeMs !== a.mtimeMs
      ? b.mtimeMs - a.mtimeMs
      : a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : 0,
  );
  return found.map((f) => f.name);
}

export function readArtifactMeta(dirName: string): ArtifactMeta {
  return JSON.parse(
    readFileSync(join(artifactStorePath(dirName), "meta.json"), "utf8"),
  ) as ArtifactMeta;
}

/** Bump the artifact dir's mtime so pruning treats reused artifacts as live. */
export function touchArtifact(dirName: string): void {
  const now = new Date();
  try {
    utimesSync(artifactStorePath(dirName), now, now);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Atomically publish a freshly-built cache dir — the ONE publish every
 * write-once cache uses (artifacts, vendor sets, the global-CSS cache): its
 * files are precompressed (`precompress.ts`), its metadata file is written
 * LAST, then the whole dir is renamed into place, so a reader sees either no
 * entry or a complete one, sidecars included. A concurrent build of the
 * identical entry (another worktree) may win the rename race — that's a
 * success (identical content), so EEXIST/ENOTEMPTY discard the loser, once
 * `isComplete` confirms the winner really is a finished entry.
 */
export async function publishDir(opts: {
  tmpDir: string;
  dest: string;
  meta: unknown;
  isComplete: () => boolean;
  /**
   * Files already carrying their sidecars (hard links to a published entry's
   * file and its `.br`/`.gz`): never compressed again.
   */
  precompressed?: ReadonlySet<string>;
}): Promise<void> {
  await precompressDir(opts.tmpDir, opts.precompressed);
  writeFileSync(
    join(opts.tmpDir, "meta.json"),
    JSON.stringify(opts.meta, null, 2),
  );
  try {
    renameSync(opts.tmpDir, opts.dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM")
      throw err;
    if (!opts.isComplete()) throw err; // dest exists but is not a complete entry
    rmSync(opts.tmpDir, { recursive: true, force: true });
  }
}

/** Publish a freshly-built artifact dir into the store ({@link publishDir}). */
export async function publishArtifact(
  dirName: string,
  tmpDir: string,
  meta: ArtifactMeta,
): Promise<void> {
  await publishDir({
    tmpDir,
    dest: artifactStorePath(dirName),
    meta,
    isComplete: () => hasArtifact(dirName),
  });
}

/** A staging area for one artifact build, inside the store (same filesystem). */
export function artifactTmpDir(dirName: string): string {
  const tmp = join(STORE_DIR, `.tmp.${dirName}.${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  return tmp;
}

/**
 * One write-once cache dir's prune bounds. The count bound applies to the
 * UNREFERENCED population only: an entry a dist links or a build lease pins is
 * a root, never a victim and never counted (see {@link pruneCacheDir}).
 */
export interface CachePrunePolicy {
  root: string;
  /** Unreferenced entries older than this go (leftover `.tmp.*` dirs after an hour). */
  maxAgeMs: number;
  /** Past this many unreferenced entries, the oldest are trimmed… */
  maxUnreferenced: number;
  /** …down to this many. */
  trimTo: number;
}

/** The artifact store's bounds (pruned by `pruneWebArtifactCaches`, `lease.ts`). */
export const STORE_PRUNE_POLICY: CachePrunePolicy = {
  root: STORE_DIR,
  maxAgeMs: MAX_AGE_MS,
  maxUnreferenced: MAX_UNREFERENCED,
  trimTo: TRIM_TO,
};

/**
 * The ONE prune policy of every write-once cache dir (artifact store, vendor
 * sets, CSS cache): age out unreferenced entries older than `maxAgeMs`
 * (leftover `.tmp.*` dirs from crashed builds after an hour), then, past
 * `maxUnreferenced` unreferenced entries, trim the oldest down to `trimTo`.
 *
 * `referenced` are absolute entry paths that are roots — every entry a dist on
 * disk links (`servedDistTargets`) and every entry a live build lease pins
 * (`liveLeaseTargets`). They are never deleted, neither by age nor by the count
 * cap, and they do not count toward it: the cap bounds what is reclaimable, so
 * it stays meaningful however many entries the fleet's dists hold. (It used to
 * count roots too, so once they alone exceeded it every prune deleted EVERY
 * unreferenced entry — including what in-flight builds were about to compose.)
 *
 * Call only under the exclusive store lock (`pruneWebArtifactCaches`): the
 * roots a lease contributes are only stable there. A build of this code pins
 * before it publishes, so its entries are always roots; an entry modified
 * within `SNAPSHOT_MARGIN_MS` of this call is still never deleted (it counts
 * toward the cap, never as a victim), for a build running older code that
 * publishes without a lease.
 */

/** Entries younger than this may belong to a build that publishes without a lease. */
const SNAPSHOT_MARGIN_MS = 60 * 1000;

export function pruneCacheDir(
  opts: CachePrunePolicy & { referenced: ReadonlySet<string> },
): void {
  let names: string[];
  try {
    names = readdirSync(opts.root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return;
  }
  const now = Date.now();
  const candidates: { path: string; mtimeMs: number }[] = [];
  let unjudged = 0;
  for (const name of names) {
    const path = join(opts.root, name);
    if (opts.referenced.has(path)) continue;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      continue; // vanished underneath us — nothing to prune
    }
    const isTmp = name.startsWith(".tmp.");
    if (now - mtimeMs > (isTmp ? 60 * 60 * 1000 : opts.maxAgeMs)) {
      removeCacheEntry(path);
    } else if (!isTmp) {
      if (now - mtimeMs < SNAPSHOT_MARGIN_MS) unjudged++;
      else candidates.push({ path, mtimeMs });
    }
  }
  const total = candidates.length + unjudged;
  if (total > opts.maxUnreferenced) {
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    // Young entries count toward the bound but are never victims.
    const excess = Math.min(candidates.length, total - opts.trimTo);
    for (const { path } of candidates.slice(0, excess)) {
      removeCacheEntry(path);
    }
  }
}

/** True iff nothing (not even a dangling link) is at `path`. */
function isGone(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return true;
  }
}

/**
 * Remove one cache entry, tolerating exactly one failure: another process
 * removing the same entry at the same time. A recursive rm racing another
 * remover fails with ENOENT (a child already unlinked) or, on macOS, EPERM (the
 * top path vanished between its stat and its unlink, so the dir is unlinked as
 * a file). Either is fine iff the entry is gone afterwards; if it is still
 * there, the other remover is mid-way, so remove it once more — any failure of
 * that attempt that leaves the entry in place is real and throws. (A prune of
 * this code is serialized by the store lock; the race is with older builds that
 * prune unlocked.)
 */
export function removeCacheEntry(
  path: string,
  rm: (path: string) => void = (p) =>
    rmSync(p, { recursive: true, force: true }),
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rm(path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EPERM") throw err;
      if (isGone(path)) return;
      if (attempt >= 1) throw err;
    }
  }
}

// ── Per-worktree fingerprint cache ──────────────────────────────────
//
// The stat-fingerprint fast path (à la `infra/corpus-index`): a worktree-scoped
// JSON mapping `<pluginPath>|<kind>` → { files: { rel: [mtimeMs, size] },
// ownHash }. When every stat matches, the recorded ownHash is reused without
// reading a byte of content.

export interface FingerprintRecord {
  files: Record<string, [number, number]>;
  ownHash: string;
  /**
   * Repo-relative static bases of the files' `import.meta.glob` patterns
   * (`own-files.ts`), recorded with the hash they were read under. Absent
   * until first computed; a rewritten record drops it, so it is re-read
   * exactly when the files change.
   */
  globRoots?: string[];
}

export interface FingerprintCache {
  version: number;
  records: Record<string, FingerprintRecord>;
}

const FINGERPRINT_CACHE_VERSION = 1;

export function loadFingerprintCache(worktreeName: string): FingerprintCache {
  const file = join(FINGERPRINTS_DIR, `${worktreeName}.json`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { version: FINGERPRINT_CACHE_VERSION, records: {} };
  }
  let parsed: FingerprintCache;
  try {
    parsed = JSON.parse(raw) as FingerprintCache;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { version: FINGERPRINT_CACHE_VERSION, records: {} };
  }
  if (
    parsed.version !== FINGERPRINT_CACHE_VERSION ||
    typeof parsed.records !== "object"
  ) {
    return { version: FINGERPRINT_CACHE_VERSION, records: {} };
  }
  return parsed;
}

export function saveFingerprintCache(
  worktreeName: string,
  cache: FingerprintCache,
): void {
  ensureStoreDirs();
  const file = join(FINGERPRINTS_DIR, `${worktreeName}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, file);
}
