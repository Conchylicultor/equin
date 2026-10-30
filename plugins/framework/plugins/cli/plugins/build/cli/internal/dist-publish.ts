// Gapless dist publish, generic over the target path. `dir` is a *symlink* →
// `<base>.live.<pid>`, the versioned release the gateway serves. A build
// compiles into `<base>.staging.<pid>/`, renames it to a `<base>.live.<pid>/`
// release, then repoints `dir` by renaming a fresh `<base>.swap.<pid>` symlink
// over it. That final rename is a POSIX-atomic replace of a symlink, so `dir`
// always resolves to a *complete* release — there is no window where it is
// absent. (`<base>.old.` is the legacy move-aside scheme; still swept for
// back-compat.)
//
// Three publishers share this machinery, and all three publish under
// `~/.equin/worktrees/`: a checkout's served dist (`<name>/web`), each
// auto-served composition's (`<id>/web` — the same arm, a namespace either way),
// and a release's scratch dist at `<wt>/release-web/<composition>`.
// Which one a build publishes is an IDENTITY it names, not a path it spells —
// see `WebDistTarget` / `webDistPath` in ./app-artifacts.ts. Leftovers from a
// crashed run are swept per target dir by `sweepDistLeftovers` at the start of
// each build.

import { existsSync, lstatSync } from "fs";
import {
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
} from "fs/promises";
import { basename, dirname, join } from "path";

export interface DistNames {
  /** The directory holding the live symlink and its transient siblings. */
  parent: string;
  /** The live symlink's basename (e.g. `dist`, `web`). */
  base: string;
  stagingPath: string;
  releaseName: string;
  releasePath: string;
  swapPath: string;
  prefixes: { staging: string; live: string; swap: string; old: string };
}

/** Pure path arithmetic for one live dir's staging/release/swap siblings. */
export function distNames(dir: string, pid: number = process.pid): DistNames {
  const parent = dirname(dir);
  const base = basename(dir);
  const prefixes = {
    staging: `${base}.staging.`,
    live: `${base}.live.`,
    swap: `${base}.swap.`,
    old: `${base}.old.`,
  };
  const releaseName = `${prefixes.live}${pid}`;
  return {
    parent,
    base,
    stagingPath: join(parent, `${prefixes.staging}${pid}`),
    releaseName,
    releasePath: join(parent, releaseName),
    swapPath: join(parent, `${prefixes.swap}${pid}`),
    prefixes,
  };
}

/** The staging dir a build of this process should compile into for `dir`. */
export function distStagingPath(
  dir: string,
  pid: number = process.pid,
): string {
  return distNames(dir, pid).stagingPath;
}

/**
 * Reclaim build leftovers and self-heal a crashed publish. `dir` is a symlink
 * → `<base>.live.<pid>`; a publish killed mid-swap can leave `dir` missing or
 * dangling while a complete `<base>.live.*` release survives on disk. Restore
 * the newest surviving release so the site is served again from the very next
 * build start, then reclaim every other transient sibling — but never the
 * release `dir` currently points at (deleting it would dangle the live symlink).
 */
export async function sweepDistLeftovers(dir: string): Promise<void> {
  const { parent, base, prefixes } = distNames(dir);
  if (!existsSync(parent)) return; // nothing was ever published here
  const entries = await readdir(parent);

  // The release `dir` currently resolves to (basename), if it is a live symlink.
  let current: string | null = null;
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) {
    if (existsSync(dir)) {
      current = basename(await readlink(dir)); // existsSync follows: false ⇒ dangling
    } else {
      await unlink(dir); // dangling symlink — drop it, restore below
    }
  }

  // No healthy `dir` but a complete release survives → repoint at the newest.
  if (current === null) {
    const releases = entries.filter((e) => e.startsWith(prefixes.live)).sort();
    const newest = releases.at(-1);
    if (newest) {
      current = newest;
      await symlink(newest, dir); // relative target, resolved within parent
    }
  }

  for (const entry of entries) {
    if (entry === current) continue;
    if (
      entry.startsWith(prefixes.staging) ||
      entry.startsWith(prefixes.live) ||
      entry.startsWith(prefixes.swap) ||
      entry.startsWith(prefixes.old) ||
      // Legacy: a build once pinned its in-flight cache entries in a
      // `<base>.pins` sibling (now a build lease, web-artifacts' `lease.ts`);
      // one a failed build left would pin its entries forever.
      entry === `${base}.pins`
    ) {
      await rm(join(parent, entry), { recursive: true, force: true });
    }
  }
}

/**
 * Publish `stagingPath` as the new release behind the `dir` symlink, gaplessly:
 * rename staging → `<base>.live.<pid>`, atomically repoint `dir` via a swap
 * symlink, then reclaim the previous release. On the one-time migration from a
 * legacy real-directory `dir`, it is removed just before the swap — that single
 * publish has a brief gap; every subsequent one is gapless.
 */
export async function publishDistAtomic(opts: {
  dir: string;
  stagingPath: string;
}): Promise<void> {
  const { parent, releaseName, releasePath, swapPath } = distNames(opts.dir);
  await mkdir(parent, { recursive: true });
  await rename(opts.stagingPath, releasePath);

  // Reclaim the release `dir` currently points at after the swap. If `dir` is
  // a legacy real directory, remove it first — a symlink cannot be renamed
  // over a non-empty directory.
  let prevRelease: string | null = null;
  const liveStat = lstatSync(opts.dir, { throwIfNoEntry: false });
  if (liveStat?.isSymbolicLink()) {
    prevRelease = basename(await readlink(opts.dir));
  } else if (liveStat?.isDirectory()) {
    await rm(opts.dir, { recursive: true, force: true });
  }

  await symlink(releaseName, swapPath); // relative target, resolved within parent
  await rename(swapPath, opts.dir); // atomic replace of the live symlink

  if (prevRelease !== null && prevRelease !== releaseName) {
    await rm(join(parent, prevRelease), { recursive: true, force: true });
  }
}
