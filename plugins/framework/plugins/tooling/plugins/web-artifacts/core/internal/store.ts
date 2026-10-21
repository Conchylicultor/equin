// Content-addressed artifact store at `~/.singularity/cache/web-artifacts/`, shared
// across worktrees: a dir per artifact keyed by its inputs hash. Reuse bumps the
// dir's mtime so live artifacts never age out; pruning follows the
// `checks/core/cache.ts` shape (age + count bounds).

import {
  existsSync,
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
// they were when they read a frozen `SINGULARITY_DIR`: three sibling modules
// (`check/index.ts`, `vendors.ts`, `global-css.ts`) already join them into
// their own module-level consts, so the whole family freezes at first import
// either way. They become functions when the store actually moves off its
// `legacyLocation`, which is the point at which a stale read could differ.
export const WEB_ARTIFACTS_DIR = webArtifactsDir.path;
export const WEB_ARTIFACTS_STORE_DIR = webArtifactsDir.file("store");
const STORE_DIR = WEB_ARTIFACTS_STORE_DIR;
const FINGERPRINTS_DIR = webArtifactsDir.file("fingerprints");

// Pruning bounds. An artifact dir is small (one module + map); the fleet is
// ~700 per builder identity, so these allow a handful of live identities.
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 8000;
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
}): Promise<void> {
  await precompressDir(opts.tmpDir);
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

/** Opportunistic prune: age-out stale artifact dirs, then cap total count. */
export function pruneStore(): void {
  ensureStoreDirs();
  let names: string[];
  try {
    names = readdirSync(STORE_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return;
  }
  const now = Date.now();
  const live: { path: string; mtimeMs: number }[] = [];
  for (const name of names) {
    const path = join(STORE_DIR, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      continue; // vanished underneath us — nothing to prune
    }
    // Leftover temp dirs from crashed builds age out like artifacts.
    if (
      now - mtimeMs > MAX_AGE_MS ||
      (name.startsWith(".tmp.") && now - mtimeMs > 60 * 60 * 1000)
    ) {
      rmSync(path, { recursive: true, force: true });
    } else if (!name.startsWith(".tmp.")) {
      live.push({ path, mtimeMs });
    }
  }
  if (live.length > MAX_ENTRIES) {
    live.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    for (const { path } of live.slice(0, live.length - TRIM_TO)) {
      rmSync(path, { recursive: true, force: true });
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
