// The cache entries a live served dist links to — the roots pruning must keep.
//
// A served dist (`<worktrees>/<ns>/web` → `web.live.<pid>`) holds no bytes of
// its own: every `artifacts/<name>` is a symlink to an absolute entry of the
// artifact store or the vendor sets. Pruning by age and count alone deleted
// entries a dist still linked (a worktree idle for a few hours of fleet builds
// lost hundreds of modules and never booted again). So the prune treats every
// link target of every dist on disk as a root.
//
// Reading a dist's links is O(its links) (~2.4k readlinks; ~450k across a host
// with 120 worktrees, 100–150 s under a file-metadata stall). But a dist's
// links never change once it is published, so each dist is read ONCE: what it
// links is memoized in the cache (`dist-links/`), stamped with its
// `artifacts/` dir's inode + mtime. A scan then costs per dist a realpath, a
// stat and one small file read — O(dists) — plus the links of the dists that
// are new or changed since their memo. The stamp is the memo's whole validity:
// adding, removing or replacing a link moves it, so a memo can only be stale by
// being ignored, never by being trusted.
//
// Still never on a build's path: the scheduled prune (`pruneWebArtifactCaches`)
// scans unlocked and re-reads only the dists that changed under the store lock
// (`refreshServedDists`).

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import {
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { basename, dirname } from "node:path";
import { worktreesDir } from "@plugins/infra/plugins/paths/core";
import { webArtifactsDir } from "../../data-dirs";
import { WORKER_TREE_PREFIX } from "../constants";
import { sha256Hex } from "../hash";

/** Where dists are found, and where what each links is memoized. */
export interface ServedDistLayout {
  /** The worktrees dir: `<ns>/web*` and `<ns>/release-web/*` are dists. */
  worktrees: AppPath;
  /** One memo file per dist (`<hash of its real path>.json`). */
  memoDir: AppPath;
}

const DEFAULT_LAYOUT: ServedDistLayout = {
  get worktrees() {
    return worktreesDir();
  },
  memoDir: webArtifactsDir.file("dist-links"),
};

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

/** Entries of `dir`, or null when it does not exist. */
function readdirOrNull(dir: AppPath): string[] | null {
  try {
    return readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    return null;
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
 * (adding, removing or replacing a link changes the dir's mtime), or null
 * when it has no such dir (it links nothing).
 */
function linksStamp(root: AppPath): string | null {
  try {
    const st = statSync(joinAppPath(root, "artifacts"), { bigint: true });
    return `${st.ino}:${st.mtimeNs}`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    return null;
  }
}

/**
 * Every cache entry the dist at `root` links, read off its links. `final` is
 * false when a linked worker tree is missing: its children are unknown, and a
 * build may publish it again at the same address — which the dist's stamp
 * would not see — so what was read must not be memoized.
 */
function readLinkTargets(root: AppPath): { targets: string[]; final: boolean } {
  const targets: string[] = [];
  let final = true;
  const artifacts = joinAppPath(root, "artifacts");
  for (const name of readdirOrEmpty(artifacts)) {
    const target = readLinkOrNull(joinAppPath(artifacts, name));
    if (target === null) continue;
    targets.push(target);
    // A worker tree is itself a dir of links into the store: what it links
    // is served too. (Write-once, like every store entry.)
    if (basename(target).startsWith(WORKER_TREE_PREFIX)) {
      const children = readdirOrNull(target);
      if (children === null) {
        final = false;
        continue;
      }
      for (const child of children) {
        const linked = readLinkOrNull(joinAppPath(target, child));
        if (linked !== null) targets.push(linked);
      }
    }
  }
  return { targets, final };
}

/**
 * A memo: the dist it describes, the stamp its links were read under, and
 * its targets grouped by parent dir (they share a handful of cache dirs, so
 * the prefix is written once: ~150 KB for a typical dist's ~4.8k links).
 */
const memoSchema = z.object({
  root: z.string(),
  stamp: z.string(),
  dirs: z.record(z.string(), z.array(z.string())),
});

/** Bump when {@link memoSchema} changes: older memos are then not found, and go. */
const MEMO_VERSION = 1;

function memoName(root: AppPath): string {
  return `v${MEMO_VERSION}-${sha256Hex(root).slice(0, 32)}.json`;
}

function memoPath(layout: ServedDistLayout, root: AppPath): AppPath {
  return joinAppPath(layout.memoDir, memoName(root));
}

/** The memoized targets of `root`, or null when there is none for `stamp`. */
function readMemo(
  layout: ServedDistLayout,
  root: AppPath,
  stamp: string,
): string[] | null {
  let raw: string;
  try {
    raw = readFileSync(memoPath(layout, root), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null; // never read, or reaped with a dist since
  }
  const memo = memoSchema.parse(JSON.parse(raw));
  if (memo.root !== root || memo.stamp !== stamp) return null; // stale
  return Object.entries(memo.dirs).flatMap(([dir, names]) =>
    names.map((name) => `${dir}/${name}`),
  );
}

/** Record `targets` as what `root` links under `stamp` (atomically). */
function writeMemo(
  layout: ServedDistLayout,
  root: AppPath,
  stamp: string,
  targets: readonly string[],
): void {
  const dirs: Record<string, string[]> = {};
  for (const t of targets) (dirs[dirname(t)] ??= []).push(basename(t));
  const file = memoPath(layout, root);
  const tmp = joinAppPath(
    layout.memoDir,
    `${memoName(root)}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`,
  );
  mkdirSync(layout.memoDir, { recursive: true });
  writeFileSync(tmp, JSON.stringify({ root, stamp, dirs }));
  renameSync(tmp, file);
}

/**
 * Every cache entry the dist at `root` links, as of `stamp` (taken BEFORE
 * this read): from its memo when the stamp still matches, else off its links
 * — memoized under that pre-read stamp, so a dist whose links change during
 * the read shows a new stamp next time and is read again.
 */
function distTargets(
  layout: ServedDistLayout,
  root: AppPath,
  stamp: string,
): { targets: string[]; readLinks: boolean } {
  const memo = readMemo(layout, root, stamp);
  if (memo !== null) return { targets: memo, readLinks: false };
  const { targets, final } = readLinkTargets(root);
  if (final) writeMemo(layout, root, stamp, targets);
  return { targets, readLinks: true };
}

/**
 * Every link target of every dist, with each dist's {@link linksStamp} taken
 * BEFORE its links were read — so a dist that changed during or after the
 * read shows a different stamp to {@link refreshServedDists}.
 */
export interface ServedDistScan {
  targets: Set<string>;
  stamps: Map<AppPath, string | null>;
  /** Dists whose links were read (no memo for their stamp), not memoized. */
  linksRead: number;
}

const TMP_GRACE_MS = 10 * 60 * 1000;

function isOlderThan(path: AppPath, ms: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > ms;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return false; // renamed into place since the listing
  }
}

/** Fold one dist into `scan`; true when its links had to be read. */
function addDist(
  scan: ServedDistScan,
  layout: ServedDistLayout,
  root: AppPath,
  stamp: string | null,
): boolean {
  scan.stamps.set(root, stamp);
  if (stamp === null) return false; // no artifacts/: links nothing
  const { targets, readLinks } = distTargets(layout, root, stamp);
  for (const t of targets) scan.targets.add(t);
  if (readLinks) scan.linksRead++;
  return readLinks;
}

/**
 * Scan every dist under the worktrees dir — O(dists) for the dists already
 * memoized, plus the links of the rest — so a prune runs it WITHOUT the store
 * lock and then calls {@link refreshServedDists} under it. Memos of dists that
 * no longer exist are deleted.
 */
export function scanServedDists(
  layout: ServedDistLayout = DEFAULT_LAYOUT,
): ServedDistScan {
  const scan: ServedDistScan = {
    targets: new Set(),
    stamps: new Map(),
    linksRead: 0,
  };
  const roots = distRoots(layout.worktrees);
  for (const root of roots) addDist(scan, layout, root, linksStamp(root));
  const live = new Set(roots.map(memoName));
  for (const name of readdirOrEmpty(layout.memoDir)) {
    if (live.has(name)) continue;
    const path = joinAppPath(layout.memoDir, name);
    // A `.tmp.` file may be a concurrent scan's write in flight: only one a
    // crashed writer left (older than any write takes) goes.
    if (name.includes(".tmp.") && !isOlderThan(path, TMP_GRACE_MS)) continue;
    rmSync(path, { force: true });
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
  layout: ServedDistLayout = DEFAULT_LAYOUT,
): { reread: number } {
  let reread = 0;
  for (const root of distRoots(layout.worktrees)) {
    const stamp = linksStamp(root);
    if (scan.stamps.has(root) && scan.stamps.get(root) === stamp) continue;
    addDist(scan, layout, root, stamp);
    reread++;
  }
  return { reread };
}

/**
 * Absolute paths of every cache entry some dist under the worktrees dir links
 * via `artifacts/<name>`. A materialized (non-symlink) artifact is a copy, not
 * a reference, and is skipped.
 */
export function servedDistTargets(
  layout: ServedDistLayout = DEFAULT_LAYOUT,
): ReadonlySet<string> {
  return scanServedDists(layout).targets;
}
