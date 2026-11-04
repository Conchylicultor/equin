// The cache entries a live served dist links to — the roots pruning must keep.
//
// A served dist (`<worktrees>/<ns>/web` → `web.live.<pid>`) holds no bytes of
// its own: every `artifacts/<name>` is a symlink to an absolute entry of the
// artifact store or the vendor sets. Pruning by age and count alone deleted
// entries a dist still linked (a worktree idle for a few hours of fleet builds
// lost hundreds of modules and never booted again). So the prune treats every
// link target of every dist on disk as a root.
//
// Cost: one readdir of the worktrees dir, one of each worktree dir, one readdir
// plus readlinks of each dist's `artifacts/` — O(every link of every dist:
// ~450k on a host with 120 worktrees), so it is never on a build's path: the
// scheduled prune (`pruneWebArtifactCaches`) reads it unlocked and re-reads
// only the dists that changed under the store lock (`refreshServedDists`).

import {
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { basename } from "node:path";
import { worktreesDir } from "@plugins/infra/plugins/paths/core";
import { WORKER_TREE_PREFIX } from "../constants";

/** Entries of `dir`; none when it does not exist (a concurrent reap races the scan). */
function readdirOrEmpty(dir: AppPath): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    return [];
  }
}

/** The target of the symlink at `path`, or null when it is not one (or gone). */
function readLinkOrNull(path: AppPath): AppPath | null {
  try {
    // A dist link the build wrote, pointing into the store.
    return asAppPath(readlinkSync(path));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EINVAL") throw err; // EINVAL: not a link
    return null;
  }
}

/**
 * Every dist root under a worktrees dir: each namespace's `web` link and its
 * `web.*` siblings (the `.live.<pid>` release behind it, a `.staging.<pid>` or
 * `.old.<pid>` mid-publish), plus release scratch dists under `release-web/`.
 * Symlinks are resolved and deduped, so a dist reached twice is scanned once.
 */
function distRoots(worktrees: AppPath): AppPath[] {
  const roots = new Set<AppPath>();
  const add = (path: AppPath): void => {
    try {
      // The real location of a dist root under the worktrees dir.
      roots.add(asAppPath(realpathSync(path)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; // dangling / raced
    }
  };
  for (const ns of readdirOrEmpty(worktrees)) {
    const nsDir = joinAppPath(worktrees, ns);
    for (const name of readdirOrEmpty(nsDir)) {
      if (
        name === "web" ||
        (name.startsWith("web.") && !name.startsWith("web.swap."))
      ) {
        add(joinAppPath(nsDir, name));
      }
    }
    const releaseDir = joinAppPath(nsDir, "release-web");
    for (const name of readdirOrEmpty(releaseDir))
      add(joinAppPath(releaseDir, name));
  }
  return [...roots];
}

/**
 * When a dist's links last changed: its `artifacts/` dir's inode and mtime
 * (adding, removing or replacing a link changes the dir's mtime), or `none`
 * when it has no such dir.
 */
function linksStamp(root: AppPath): string {
  try {
    const st = statSync(joinAppPath(root, "artifacts"), { bigint: true });
    return `${st.ino}:${st.mtimeNs}`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    return "none";
  }
}

/** Add every cache entry the dist at `root` links to `targets`. */
function addLinkTargets(root: AppPath, targets: Set<string>): void {
  const artifacts = joinAppPath(root, "artifacts");
  for (const name of readdirOrEmpty(artifacts)) {
    const target = readLinkOrNull(joinAppPath(artifacts, name));
    if (target === null) continue;
    targets.add(target);
    // A worker tree is itself a dir of links into the store: what it links
    // is served too. (Write-once, like every store entry.)
    if (basename(target).startsWith(WORKER_TREE_PREFIX)) {
      for (const child of readdirOrEmpty(target)) {
        const linked = readLinkOrNull(joinAppPath(target, child));
        if (linked !== null) targets.add(linked);
      }
    }
  }
}

/**
 * Every link target of every dist, with each dist's {@link linksStamp} taken
 * BEFORE its links were read — so a dist that changed during or after the
 * read shows a different stamp to {@link refreshServedDists}.
 */
export interface ServedDistScan {
  targets: Set<string>;
  stamps: Map<AppPath, string>;
}

/**
 * Scan every dist under a worktrees dir: one readdir plus a readlink per link
 * of every dist — O(the fleet's dists), so a prune runs it WITHOUT the store
 * lock and then calls {@link refreshServedDists} under it.
 */
export function scanServedDists(
  worktrees: AppPath = worktreesDir(),
): ServedDistScan {
  const scan: ServedDistScan = { targets: new Set(), stamps: new Map() };
  for (const root of distRoots(worktrees)) {
    scan.stamps.set(root, linksStamp(root));
    addLinkTargets(root, scan.targets);
  }
  return scan;
}

/**
 * Bring a scan up to date: list the dist roots again and re-read only the
 * dists that are new or whose links changed since the scan (their stamp
 * differs) — O(dists) metadata calls plus the links of what changed. A dist
 * removed since keeps its targets in the set, which only keeps more.
 */
export function refreshServedDists(
  scan: ServedDistScan,
  worktrees: AppPath = worktreesDir(),
): { reread: number } {
  let reread = 0;
  for (const root of distRoots(worktrees)) {
    const stamp = linksStamp(root);
    if (scan.stamps.get(root) === stamp) continue;
    scan.stamps.set(root, stamp);
    addLinkTargets(root, scan.targets);
    reread++;
  }
  return { reread };
}

/**
 * Absolute paths of every cache entry some dist under `worktrees` links via
 * `artifacts/<name>`. A materialized (non-symlink) artifact is a copy, not a
 * reference, and is skipped.
 */
export function servedDistTargets(
  worktrees: AppPath = worktreesDir(),
): ReadonlySet<string> {
  return scanServedDists(worktrees).targets;
}
