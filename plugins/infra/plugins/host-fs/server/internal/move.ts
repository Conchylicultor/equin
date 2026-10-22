import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  realpath,
  rename as fsRename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import {
  type HostFsMoveOutcome,
  type HostFsMoveResolution,
  type HostFsMoveResult,
} from "../../core";
import { locateHostPath } from "./archive/locate";
import { freePath, isTaken } from "./free-path";
import { classifyFsError } from "./path";

/** `rename(2)`, injectable so a test can stand in a cross-volume (`EXDEV`) one. */
export type RenameFn = (from: string, to: string) => Promise<void>;

/** Whether `path` is `ancestor` or lies below it (both absolute, resolved). */
function isWithin(path: string, ancestor: string): boolean {
  return (
    path === ancestor ||
    path.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep)
  );
}

/**
 * The path with its parent's symlinks resolved but not itself: moving a
 * symlink moves the link, so the link's own location is what is compared.
 */
async function realLocation(path: string): Promise<string> {
  return join(await realpath(dirname(path)), basename(path));
}

/**
 * Move `from` to `to` (which must be free). Across volumes `rename` fails with
 * `EXDEV`: the tree is copied into a hidden staging sibling of `to`, moved
 * into place once whole, and only then is the source removed — so a failed
 * copy leaves the source untouched and nothing half-copied behind.
 */
export async function movePath(
  from: string,
  to: string,
  rename: RenameFn = fsRename,
): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== "EXDEV") throw err;
  }
  const staging = join(dirname(to), `.${basename(to)}.moving-${randomUUID()}`);
  try {
    await cp(from, staging, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    await fsRename(staging, to);
  } finally {
    // Gone already once the staging copy was moved into place.
    await rm(staging, { recursive: true, force: true });
  }
  await rm(from, { recursive: true });
}

/**
 * Replace the entry at `to` with `from`: the taken entry is first set aside
 * in a hidden sibling, put back if the move fails, and removed once it lands.
 */
async function replacePath(
  from: string,
  to: string,
  rename: RenameFn,
): Promise<void> {
  const aside = join(dirname(to), `.${basename(to)}.replaced-${randomUUID()}`);
  await fsRename(to, aside);
  try {
    await movePath(from, to, rename);
  } catch (err) {
    await fsRename(aside, to);
    throw err;
  }
  await rm(aside, { recursive: true, force: true });
}

async function moveOne(
  from: string,
  destDir: string,
  realDest: string,
  resolution: HostFsMoveResolution | undefined,
  rename: RenameFn,
): Promise<HostFsMoveOutcome> {
  if ((await locateHostPath(from)).kind === "archive") {
    return { kind: "archive", from };
  }
  let isDir: boolean;
  let realFrom: string;
  try {
    isDir = (await lstat(from)).isDirectory();
    realFrom = await realLocation(from);
  } catch (err) {
    return { kind: classifyFsError(err), from };
  }
  if (isWithin(realDest, realFrom)) return { kind: "into-self", from };
  if (dirname(realFrom) === realDest) return { kind: "same-dir", from };

  let to = join(destDir, basename(from));
  const taken = await isTaken(to);
  try {
    if (!taken) {
      await movePath(from, to, rename);
    } else if (resolution === undefined) {
      return { kind: "exists", from, to };
    } else if (resolution === "skip") {
      return { kind: "skipped", from };
    } else if (resolution === "keep-both") {
      to = await freePath(destDir, basename(from), !isDir);
      await movePath(from, to, rename);
    } else {
      if (isWithin(realFrom, await realLocation(to))) {
        return { kind: "replaces-ancestor", from, to };
      }
      await replacePath(from, to, rename);
    }
  } catch (err) {
    return { kind: classifyFsError(err), from };
  }
  return { kind: "moved", from, to };
}

/**
 * Move each of `sources` (absolute) into the folder `destDir` (absolute), one
 * after another, so two sources sharing a name collide like any other. A
 * source whose name is taken moves only under its `resolutions` entry (keyed
 * by absolute source path).
 */
export async function moveHostPaths(
  sources: readonly string[],
  destDir: string,
  resolutions: ReadonlyMap<string, HostFsMoveResolution>,
  rename: RenameFn = fsRename,
): Promise<HostFsMoveResult> {
  if ((await locateHostPath(destDir)).kind === "archive") {
    return { kind: "archive", path: destDir };
  }
  let realDest: string;
  try {
    if (!(await stat(destDir)).isDirectory()) {
      return { kind: "not-a-dir", path: destDir };
    }
    realDest = await realpath(destDir);
  } catch (err) {
    return { kind: classifyFsError(err), path: destDir };
  }
  const results: HostFsMoveOutcome[] = [];
  for (const from of sources) {
    results.push(
      await moveOne(from, destDir, realDest, resolutions.get(from), rename),
    );
  }
  return { kind: "ok", destDir, results };
}
