// Carry-forward: a SERVED dist keeps serving every address it has ever served,
// for as long as the shared cache still holds the bytes behind it.
//
// A tab resolves every import through the import map baked into the page it
// loaded, so a tab booted from an older build asks for that build's addresses —
// lazily, possibly hours later (the deferred plugin tier, fonts). Each build
// used to serve only its own addresses, so every plugin that changed since the
// tab booted 404'd and the browser remembered the failure for the life of the
// page. The files themselves were still in the cache, just no longer linked.
//
// Serving an old address is safe because every address is write-once: an
// artifact's name is a hash of everything its bytes inline, and the store, the
// vendor sets and the CSS cache all discard a second publish of an existing
// address. So an old tab gets byte-for-byte the files it was built with, and it
// cannot reach a newer build's files through its own map. (Why this lives in
// `cli/` and not `core/`: see ../index.ts.)
//
// Design: research/2026-09-10-global-stale-tab-plugin-loading.md (Part 1).

import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { webArtifactsDir } from "../../data-dirs";

/**
 * Where the global CSS pass caches its output: one dir per stylesheet key,
 * holding the stylesheet and its font files. Must be the root `global-css.ts`
 * writes (its private `CSS_ROOT`) — the tie is asserted by this file's test.
 */
export function globalCssCacheRoot(): string {
  return webArtifactsDir.file("css");
}

export interface CarryForwardResult {
  /** `artifacts/<name>` links recreated in staging from the live dist. */
  artifactsCarried: string[];
  /** `assets/<file>` files copied into staging from the live dist. */
  assetsCarried: string[];
  /** `artifacts/<name>` links NOT carried: their cache target was pruned. */
  artifactsDropped: string[];
}

/**
 * Before a served dist is published, copy into `stagingDir` every entry the
 * live dist has, the new build lacks, and the shared cache still holds:
 *
 * - `artifacts/<name>` — a symlink to an absolute path in the artifact store or
 *   the vendors dir. Recreated as the same link iff its target still exists. A
 *   target exists only once fully published (it is renamed into place after its
 *   `meta.json` is written), so existence is an exact test. A link whose target
 *   is gone is dropped: an honest 404 instead of a dangling link.
 * - `assets/<file>` — the global stylesheet and its fonts, which are COPIED into
 *   every dist rather than linked, so their mtime says nothing about age. One is
 *   kept only while some CSS cache dir still contains a file of that name (the
 *   names are content-hashed by vite, so a name is its bytes).
 *
 * Because each served dist already contains everything carried into it, a
 * build only diffs against the one dist before it. The carried set is therefore
 * "everything this namespace ever served that the cache still holds", bounded
 * by the cache's own pruning (14 days after last use). Carrying never touches a
 * target's mtime, so it never extends that life.
 *
 * Only for a SERVED dist. A release is served by nobody and ships its dist
 * materialized; it never carries.
 *
 * ACCEPTED RACE — do not "fix" it with a lock: another worktree's build may
 * prune a target between the existence check here and the publish swap. That
 * one address then 404s until this namespace's next publish drops the link.
 * Serializing every build's prune against every other build's publish would
 * cost far more than the rare 404 it prevents.
 *
 * No-op when `liveDir` does not exist (the namespace's first build).
 *
 * @param opts.liveDir the served dist, still resolving to the PREVIOUS build.
 * @param opts.stagingDir this build's dist, fully composed, not yet published.
 * @param opts.cssCacheRoot test seam; defaults to {@link globalCssCacheRoot}.
 */
export function carryForwardServedEntries(opts: {
  liveDir: string;
  stagingDir: string;
  cssCacheRoot?: string;
}): CarryForwardResult {
  const result: CarryForwardResult = {
    artifactsCarried: [],
    assetsCarried: [],
    artifactsDropped: [],
  };
  if (!existsSync(opts.liveDir)) return result;

  const liveArtifacts = join(opts.liveDir, "artifacts");
  const stagingArtifacts = join(opts.stagingDir, "artifacts");
  for (const name of listDir(liveArtifacts)) {
    const dest = join(stagingArtifacts, name);
    if (lstatSync(dest, { throwIfNoEntry: false })) continue; // this build has it
    const src = join(liveArtifacts, name);
    if (!lstatSync(src).isSymbolicLink()) {
      throw new Error(
        `carry-forward: ${src} is not a symlink. A served dist links every artifact ` +
          `into the shared cache (only a release materializes), so this dist was not ` +
          `produced the way this function assumes.`,
      );
    }
    const target = readlinkSync(src);
    if (!isAbsolute(target)) {
      throw new Error(
        `carry-forward: ${src} links to a relative path (${target}); compose links ` +
          `artifacts to absolute cache paths, so re-creating it elsewhere would change ` +
          `what it points at.`,
      );
    }
    if (!existsSync(target)) {
      result.artifactsDropped.push(name);
      continue;
    }
    mkdirSync(stagingArtifacts, { recursive: true });
    symlinkSync(target, dest);
    result.artifactsCarried.push(name);
  }

  const liveAssets = join(opts.liveDir, "assets");
  const stagingAssets = join(opts.stagingDir, "assets");
  const liveNames = listDir(liveAssets);
  if (liveNames.length === 0) return result;
  const cached = cachedCssAssetNames(opts.cssCacheRoot ?? globalCssCacheRoot());
  for (const name of liveNames) {
    const dest = join(stagingAssets, name);
    if (lstatSync(dest, { throwIfNoEntry: false })) continue; // this build has it
    if (!cached.has(name)) continue; // pruned from the cache — let it go
    mkdirSync(stagingAssets, { recursive: true });
    // A clone where the filesystem supports it (APFS), a plain copy elsewhere.
    copyFileSync(join(liveAssets, name), dest, fsConstants.COPYFILE_FICLONE);
    result.assetsCarried.push(name);
  }
  return result;
}

/** Entry names of `dir`, sorted; none when the dir does not exist. */
function listDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

/**
 * Every file name held by any CSS cache dir. The scan is bounded by the CSS
 * cache's own count cap (`CSS_PRUNE_POLICY`, ≤600 dirs of ~20 files — a CSS
 * entry is copied into a dist, never linked, so only an in-flight build's lease
 * ever exempts one from it). A
 * leftover temp dir from a crashed pass is counted too: its files are genuine
 * pass output, so it can only lengthen a name's retention by the hour such a
 * dir survives.
 */
function cachedCssAssetNames(cssCacheRoot: string): Set<string> {
  const names = new Set<string>();
  if (!existsSync(cssCacheRoot)) return names;
  for (const entry of readdirSync(cssCacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let files: string[];
    try {
      files = readdirSync(join(cssCacheRoot, entry.name));
    } catch (err) {
      // Another worktree's build pruned it since the listing: it holds nothing.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      continue;
    }
    for (const name of files) {
      if (name !== "meta.json") names.add(name);
    }
  }
  return names;
}
