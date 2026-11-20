import { randomUUID } from "node:crypto";
import { cp, rename, rm } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { lstat, realpath, stat } from "@plugins/packages/plugins/timed-fs/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { SYSTEM_ZIP } from "@plugins/infra/plugins/paths/server";
import type {
  FileCompressResult,
  FileCopyOutcome,
  FileCopyResult,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { locateHostPath } from "../../server/internal/archive/locate";
import { freePath } from "../../server/internal/free-path";
import { classifyFsError } from "../../server/internal/path";
import {
  asUserPath,
  type UserPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// The computer's copy (a paste of copied entries) and compress: both write
// something new beside what exists, never over it — a taken name gets the
// Finder's next free one — and build it in a hidden sibling first, moved into
// place once whole, so a failure leaves nothing half-made behind.

/** Whether `path` is `ancestor` or lies below it (both resolved). */
function isWithin(path: string, ancestor: string): boolean {
  return (
    path === ancestor ||
    path.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep)
  );
}

async function copyOne(
  from: UserPath,
  destDir: UserPath,
  realDest: string,
): Promise<FileCopyOutcome> {
  if ((await locateHostPath(from)).kind === "archive") {
    return { kind: "archive", from };
  }
  let isDir: boolean;
  try {
    const info = await lstat(from);
    isDir = info.isDirectory();
    // A folder into itself (or below itself) would copy forever.
    if (isDir && isWithin(realDest, await realpath(from))) {
      return { kind: "into-self", from };
    }
  } catch (err) {
    return { kind: classifyFsError(err), from };
  }
  const to = await freePath(destDir, basename(from), !isDir);
  const staging = join(destDir, `.${basename(to)}.copying-${randomUUID()}`);
  try {
    await cp(from, staging, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    await rename(staging, to);
  } catch (err) {
    return { kind: classifyFsError(err), from };
  } finally {
    // Gone already once the staging copy was moved into place.
    await rm(staging, { recursive: true, force: true });
  }
  return { kind: "copied", from, to };
}

/**
 * Copy `sources` into `destDir` (`computerFileCopy`): each under its own
 * name, or the next free one when taken — so a paste into the folder they
 * came from duplicates them.
 */
export async function copyHostPaths(
  sources: readonly UserPath[],
  destDir: UserPath,
): Promise<FileCopyResult> {
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
  const results: FileCopyOutcome[] = [];
  for (const from of sources) {
    results.push(await copyOne(from, destDir, realDest));
  }
  return { kind: "ok", destDir, results };
}

/** How long one compress may run: a bound on `zip`, generous for a big folder. */
const COMPRESS_TIMEOUT_MS = 10 * 60_000;

/**
 * Compress `paths` — entries of one folder — into a .zip beside them
 * (`computerFileCompress`): `<name>.zip` for one, `Archive.zip` for several,
 * numbered when taken. 501 where the system has no `zip`.
 */
export async function compressHostPaths(
  paths: readonly UserPath[],
): Promise<FileCompressResult> {
  if (SYSTEM_ZIP === null) {
    throw new HttpError(501, "Compress needs the system's zip, not found here");
  }
  const dir = asUserPath(dirname(paths[0]!));
  if (paths.some((p) => dirname(p) !== dir)) return { kind: "mixed-folders" };
  for (const path of paths) {
    if ((await locateHostPath(path)).kind === "archive") {
      return { kind: "archive", path };
    }
    try {
      await lstat(path);
    } catch (err) {
      return { kind: classifyFsError(err), path };
    }
  }
  const name =
    paths.length === 1 ? `${basename(paths[0]!)}.zip` : "Archive.zip";
  const staging = join(dir, `.${name}.compressing-${randomUUID()}.zip`);
  try {
    // -r folders whole, -y links as links, -q quiet; names relative to the
    // folder, so the archive holds the entries, not their path.
    const run = await spawnCaptured(
      [
        SYSTEM_ZIP,
        "-r",
        "-y",
        "-q",
        staging,
        "--",
        ...paths.map((p) => basename(p)),
      ],
      { cwd: dir, timeoutMs: COMPRESS_TIMEOUT_MS },
    );
    if (run.exitCode !== 0) {
      if (/permission denied/i.test(run.stderr)) {
        return { kind: "denied", path: dir };
      }
      throw new Error(
        `host-fs: zip exited ${run.exitCode} compressing in ${dir}: ${run.stderr.trim()}`,
      );
    }
    const to = await freePath(dir, name, true);
    await rename(staging, to);
    return { kind: "compressed", path: to };
  } finally {
    await rm(staging, { force: true });
  }
}
