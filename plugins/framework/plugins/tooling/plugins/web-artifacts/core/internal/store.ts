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
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
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

export function artifactStorePath(dirName: string): AppPath {
  return joinAppPath(STORE_DIR, dirName);
}

export function ensureStoreDirs(): void {
  mkdirSync(STORE_DIR, { recursive: true });
}

/** True iff the artifact completed publishing (meta.json is written last). */
export function hasArtifact(dirName: string): boolean {
  return existsSync(joinAppPath(artifactStorePath(dirName), "meta.json"));
}

// ── Artifact groups ──────────────────────────────────────────────────
//
// A planner that must try every stored build of something (a browser host's
// records, `browser-hosts.ts`) needs the store names in one group. Listing the
// store for a prefix reads every entry of every checkout's builds (~27k names)
// on every build, so each group is an index dir instead: one empty file per
// member, written when the member is published (`indexArtifact`), dropped by
// the prune once the member is gone (`pruneArtifactIndex`).

const INDEX_DIR = webArtifactsDir.file("index");

/** A group's index dir; the group is a store-name prefix (`<slug>.browser-host.`). */
function groupIndexDir(group: string): AppPath {
  return joinAppPath(INDEX_DIR, group);
}

/** Record that `dirName` (a published store entry) belongs to `group`. */
export function indexArtifact(group: string, dirName: string): void {
  if (!dirName.startsWith(group)) {
    throw new Error(`artifact ${dirName} is not in group ${group}`);
  }
  const dir = groupIndexDir(group);
  mkdirSync(dir, { recursive: true });
  writeFileSync(joinAppPath(dir, dirName), "");
}

/**
 * Every complete artifact of `group`, most recently used first (reuse bumps a
 * dir's mtime — {@link touchArtifact}), ties by name. Reads the group's index,
 * never the store's listing — except once, when the index does not exist yet:
 * it is then built from the store (entries published before indexes existed).
 */
export function listArtifacts(group: string): string[] {
  let names: string[];
  try {
    names = readdirSync(groupIndexDir(group));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    names = backfillGroupIndex(group);
  }
  const found: { name: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!hasArtifact(name)) continue;
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

/** The store's members of `group`, recorded into its (new) index. */
function backfillGroupIndex(group: string): string[] {
  let names: string[];
  try {
    names = readdirSync(STORE_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    names = [];
  }
  const members = names.filter((n) => n.startsWith(group) && hasArtifact(n));
  mkdirSync(groupIndexDir(group), { recursive: true });
  for (const name of members) indexArtifact(group, name);
  return members;
}

/**
 * Drop every record of a group index whose entry under `root` is gone. Run by
 * `pruneCacheDir` after its deletes, for a policy that names an `index`.
 */
function pruneGroupIndex(indexDir: AppPath, root: AppPath): void {
  let groups: string[];
  try {
    groups = readdirSync(indexDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return;
  }
  for (const group of groups) {
    const dir = joinAppPath(indexDir, group);
    for (const name of readdirSync(dir)) {
      if (existsSync(joinAppPath(root, name))) continue;
      rmSync(joinAppPath(dir, name), { force: true });
    }
  }
}

export function readArtifactMeta(dirName: string): ArtifactMeta {
  return JSON.parse(
    readFileSync(joinAppPath(artifactStorePath(dirName), "meta.json"), "utf8"),
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
  tmpDir: AppPath;
  dest: AppPath;
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
    joinAppPath(opts.tmpDir, "meta.json"),
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
  tmpDir: AppPath,
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
export function artifactTmpDir(dirName: string): AppPath {
  const tmp = joinAppPath(STORE_DIR, `.tmp.${dirName}.${process.pid}`);
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
  root: AppPath;
  /** Unreferenced entries older than this go (leftover `.tmp.*` dirs after an hour). */
  maxAgeMs: number;
  /** Past this many unreferenced entries, the oldest are trimmed… */
  maxUnreferenced: number;
  /** …down to this many. */
  trimTo: number;
  /** A group index naming entries of `root` (`indexArtifact`): its records of removed entries go too. */
  index?: AppPath;
}

/** The artifact store's bounds (pruned by `pruneWebArtifactCaches`, `lease.ts`). */
export const STORE_PRUNE_POLICY: CachePrunePolicy = {
  root: STORE_DIR,
  maxAgeMs: MAX_AGE_MS,
  maxUnreferenced: MAX_UNREFERENCED,
  trimTo: TRIM_TO,
  index: INDEX_DIR,
};

/** Entries younger than this may belong to a build that publishes without a lease. */
const SNAPSHOT_MARGIN_MS = 60 * 1000;

/** One cache entry as a survey saw it: its path and its mtime then. */
export interface SurveyedEntry {
  path: AppPath;
  name: string;
  mtimeMs: number;
}

/** A cache dir as {@link surveyCacheDir} saw it, and when it started looking. */
export interface CacheSurvey {
  /** Ages are judged as of this instant, however long ago the survey ran. */
  atMs: number;
  entries: SurveyedEntry[];
}

/**
 * List one cache dir and stat every entry not already known to be a root —
 * the expensive half of a prune (one stat per entry), and safe to run WITHOUT
 * the store lock: it decides nothing. {@link pruneCacheDir} then judges the
 * survey under the lock against the final roots, and re-stats only the entries
 * it is about to delete. An entry published after the survey is not in it, so
 * it is never a victim.
 */
export function surveyCacheDir(
  root: AppPath,
  knownRoots: ReadonlySet<string>,
): CacheSurvey {
  const atMs = Date.now();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { atMs, entries: [] };
  }
  const entries: SurveyedEntry[] = [];
  for (const name of names) {
    const path = joinAppPath(root, name);
    if (knownRoots.has(path)) continue;
    const mtimeMs = mtimeOrNull(path);
    if (mtimeMs !== null) entries.push({ path, name, mtimeMs });
  }
  return { atMs, entries };
}

/** The entry's mtime, or null when it vanished underneath us. */
function mtimeOrNull(path: AppPath): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
}

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
 * publishes without a lease. (With an unlocked `survey`, "this call" is the
 * survey: an entry published since is not in it at all.)
 */
export function pruneCacheDir(
  opts: CachePrunePolicy & {
    referenced: ReadonlySet<string>;
    /**
     * What an unlocked {@link surveyCacheDir} saw. Omitted: the dir is
     * surveyed here, under the caller's lock.
     */
    survey?: CacheSurvey;
  },
): number {
  const survey = opts.survey ?? surveyCacheDir(opts.root, opts.referenced);
  const now = survey.atMs;
  const aged: SurveyedEntry[] = [];
  const candidates: SurveyedEntry[] = [];
  let unjudged = 0;
  for (const entry of survey.entries) {
    if (opts.referenced.has(entry.path)) continue;
    const isTmp = entry.name.startsWith(".tmp.");
    if (now - entry.mtimeMs > (isTmp ? 60 * 60 * 1000 : opts.maxAgeMs)) {
      aged.push(entry);
    } else if (!isTmp) {
      if (now - entry.mtimeMs < SNAPSHOT_MARGIN_MS) unjudged++;
      else candidates.push(entry);
    }
  }
  const victims = aged;
  const total = candidates.length + unjudged;
  if (total > opts.maxUnreferenced) {
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    // Young entries count toward the bound but are never victims.
    const excess = Math.min(candidates.length, total - opts.trimTo);
    victims.push(...candidates.slice(0, excess));
  }
  let removed = 0;
  for (const { path, mtimeMs } of victims) {
    // A reuse since the survey bumped its mtime (`touchArtifact`): it was
    // judged on a stale age, so it stays until the next prune judges it again.
    if (mtimeOrNull(path) !== mtimeMs) continue;
    removeCacheEntry(path);
    removed++;
  }
  if (opts.index !== undefined) pruneGroupIndex(opts.index, opts.root);
  return removed;
}

/** True iff nothing (not even a dangling link) is at `path`. */
function isGone(path: AppPath): boolean {
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
  path: AppPath,
  rm: (path: AppPath) => void = (p) =>
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

// ── Glob patterns per blob ───────────────────────────────────────────
//
// An artifact's address includes the files its modules `import.meta.glob`
// (`own-files.ts`), so planning must know each own module's glob patterns —
// a fact of the module's CONTENT alone. Keyed by git blob id, shared by every
// worktree: a warm build reads none of its source to know them, a fresh
// worktree from main reads none either, and an edit costs one read of the
// edited file. Patterns, not roots: a root is resolved against the module's
// path, which the blob does not know.

export interface GlobPatternMemo {
  /** The recorded patterns of `blob`, or undefined when never read. */
  get(blob: string): readonly string[] | undefined;
  set(blob: string, patterns: readonly string[]): void;
  /**
   * Persist what this run learned (merged with what others wrote meanwhile);
   * nothing to do when it learned nothing.
   */
  save(): void;
}

const GLOB_PATTERNS_FILE = webArtifactsDir.file("glob-patterns.json");
const GLOB_PATTERNS_VERSION = 1;
// A blob id set only grows (every version of every file ever planned). Past
// this many, a save keeps only the blobs this run read or learned: the live
// tree's, which the next run asks for again.
const GLOB_PATTERNS_MAX = 100_000;

function readGlobPatterns(): Map<string, readonly string[]> {
  let raw: string;
  try {
    raw = readFileSync(GLOB_PATTERNS_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return new Map();
  }
  let parsed: { version?: unknown; patterns?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch (err) {
    // A torn or foreign file holds no fact worth keeping: every blob is read
    // again, which is what a missing file means too.
    if (!(err instanceof SyntaxError)) throw err;
    return new Map();
  }
  if (
    parsed.version !== GLOB_PATTERNS_VERSION ||
    typeof parsed.patterns !== "object" ||
    parsed.patterns === null
  ) {
    return new Map();
  }
  return new Map(
    Object.entries(parsed.patterns as Record<string, readonly string[]>),
  );
}

export function loadGlobPatternMemo(): GlobPatternMemo {
  const known = readGlobPatterns();
  const used = new Map<string, readonly string[]>();
  let learned = false;
  return {
    get(blob) {
      const hit = known.get(blob);
      if (hit !== undefined) used.set(blob, hit);
      return hit;
    },
    set(blob, patterns) {
      known.set(blob, patterns);
      used.set(blob, patterns);
      learned = true;
    },
    save() {
      if (!learned) return;
      learned = false;
      ensureStoreDirs();
      // Merge rather than overwrite: another worktree's build may have written
      // since this one read. A lost race only costs a re-read.
      const merged = readGlobPatterns();
      for (const [blob, patterns] of used) merged.set(blob, patterns);
      const kept = merged.size > GLOB_PATTERNS_MAX ? used : merged;
      const tmp = `${GLOB_PATTERNS_FILE}.${process.pid}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({
          version: GLOB_PATTERNS_VERSION,
          patterns: Object.fromEntries(kept),
        }),
      );
      renameSync(tmp, GLOB_PATTERNS_FILE);
    },
  };
}
