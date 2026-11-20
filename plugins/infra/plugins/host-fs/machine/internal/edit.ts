import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  lstat,
  readFile,
  realpath,
  stat,
} from "@plugins/packages/plugins/timed-fs/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { MACOS_TRASH } from "@plugins/infra/plugins/paths/server";
import {
  isValidEntryName,
  type FileCreateResult,
  type FileRemoveOutcome,
  type FileRemoveResult,
  type FileRenameResult,
  type FileWriteResult,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { locateHostPath } from "../../server/internal/archive/locate";
import { freePath, isTaken } from "../../server/internal/free-path";
import { classifyFsError } from "../../server/internal/path";
import {
  asUserPath,
  type UserPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// The computer's edits (file-systems' `computerFileCreate` / `Rename` /
// `Delete` / `Trash` / `Write`): each refuses an archive member (a virtual
// path — nothing on disk to change) and answers `missing` / `denied` by
// errno, as the move does. Listings and stats are live (pushed from watches
// of the folders), so nothing here tells a reader to re-read.

/** Whether `path` lies inside an archive (a member, never the archive file itself). */
async function inArchive(path: UserPath): Promise<boolean> {
  return (await locateHostPath(path)).kind === "archive";
}

/**
 * Create an empty file or folder named `name` (or its next free spelling) in
 * `dir`. Exclusive: a name taken between the free-name probe and the create
 * is never overwritten — the create fails, and the next spelling is tried.
 */
export async function createHostEntry(
  dir: UserPath,
  name: string,
  kind: "file" | "dir",
): Promise<FileCreateResult> {
  if (!isValidEntryName(name)) return { kind: "invalid-name", name };
  if (await inArchive(dir)) return { kind: "archive", path: dir };
  try {
    if (!(await stat(dir)).isDirectory())
      return { kind: "not-a-dir", path: dir };
  } catch (err) {
    return { kind: classifyFsError(err), path: dir };
  }
  // A handful of tries: each loses only to a writer that took the very name
  // the probe found free a moment before.
  for (let attempt = 0; attempt < 5; attempt++) {
    const path = await freePath(dir, name, kind === "file");
    try {
      if (kind === "file") await writeFile(path, "", { flag: "wx" });
      else await mkdir(path);
      return { kind: "created", path };
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
        continue;
      }
      return { kind: classifyFsError(err), path: dir };
    }
  }
  throw new Error(
    `create in ${dir}: every free spelling of “${name}” was taken as it was tried`,
  );
}

/**
 * Rename `path` to `name` in its own folder. Never replaces another entry; a
 * change of case only (`a.txt` → `A.txt` on a case-insensitive volume, where
 * both spellings are the one entry) goes through.
 */
export async function renameHostEntry(
  path: UserPath,
  name: string,
): Promise<FileRenameResult> {
  if (!isValidEntryName(name)) return { kind: "invalid-name", name };
  if (await inArchive(path)) return { kind: "archive", path };
  const to = asUserPath(join(dirname(path), name));
  try {
    const from = await lstat(path);
    if (to === path) return { kind: "renamed", from: path, to };
    if (await isTaken(to)) {
      const there = await lstat(to);
      const same = there.ino === from.ino && there.dev === from.dev;
      if (!same) return { kind: "exists", from: path, to };
    }
    await rename(path, to);
  } catch (err) {
    return { kind: classifyFsError(err), path };
  }
  return { kind: "renamed", from: path, to };
}

/** Delete each of `paths` for good, a folder with everything in it. */
export async function deleteHostPaths(
  paths: readonly UserPath[],
): Promise<FileRemoveResult> {
  const results: FileRemoveOutcome[] = [];
  for (const path of paths) {
    if (await inArchive(path)) {
      results.push({ kind: "archive", path });
      continue;
    }
    try {
      await lstat(path);
      await rm(path, { recursive: true });
      results.push({ kind: "removed", path });
    } catch (err) {
      results.push({ kind: classifyFsError(err), path });
    }
  }
  return { results };
}

/** One `trash` run is a rename into the Trash; far past any healthy answer. */
const TRASH_TIMEOUT_MS = 30_000;

/**
 * Move each of `paths` to the Trash through macOS's `trash` command — one run
 * per path, so each gets its own outcome. A path gone or unreadable before
 * the run answers as such; a run that fails on a path that is there is
 * unexpected and throws. 501 off macOS, or on a macOS without the command.
 */
export async function trashHostPaths(
  paths: readonly UserPath[],
): Promise<FileRemoveResult> {
  if (process.platform !== "darwin") {
    throw new HttpError(
      501,
      `Move to Trash is macOS-only (this host is ${process.platform})`,
    );
  }
  const trashBin = MACOS_TRASH;
  if (trashBin === null) {
    throw new HttpError(
      501,
      "Move to Trash needs macOS's `trash` command (macOS 15 or later)",
    );
  }
  const results: FileRemoveOutcome[] = [];
  for (const path of paths) {
    if (await inArchive(path)) {
      results.push({ kind: "archive", path });
      continue;
    }
    try {
      await lstat(path);
    } catch (err) {
      results.push({ kind: classifyFsError(err), path });
      continue;
    }
    // `path` is absolute (resolveHostPath), so it is never read as a flag.
    const run = await spawnCaptured([trashBin, path], {
      timeoutMs: TRASH_TIMEOUT_MS,
    });
    if (run.exitCode === 0) {
      results.push({ kind: "removed", path });
      continue;
    }
    // Gone between the check and the run, or refused by the system.
    if (!(await isTaken(path))) {
      results.push({ kind: "missing", path });
    } else if (/permission|not permitted|Code=513/i.test(run.stderr)) {
      results.push({ kind: "denied", path });
    } else {
      throw new Error(
        `trash ${path}: exit ${run.exitCode}${run.timedOut ? " (timed out)" : ""}: ${run.stderr.trim()}`,
      );
    }
  }
  return { results };
}

/**
 * Save `text` into the existing file `path` as UTF-8: written to a hidden
 * sibling, given the file's permissions, and renamed over it — so a reader
 * sees the old bytes or the new ones. With `expected`, only while the file
 * still holds that text (else `changed`).
 */
export async function writeHostText(
  path: UserPath,
  text: string,
  expected: string | undefined,
): Promise<FileWriteResult> {
  if (await inArchive(path)) return { kind: "archive", path };
  let mode: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) return { kind: "not-a-file", path };
    mode = st.mode & 0o7777;
    if (expected !== undefined) {
      const current = await readFile(path, "utf8");
      if (current !== expected) return { kind: "changed", path };
    }
  } catch (err) {
    return { kind: classifyFsError(err), path };
  }
  // The real file a symlink names is what is written, so the link stays one.
  const target = await realpath(path);
  const temp = join(
    dirname(target),
    `.${basename(target)}.saving-${randomUUID()}`,
  );
  const bytes = Buffer.from(text, "utf8");
  try {
    await writeFile(temp, bytes, { flag: "wx" });
    await chmod(temp, mode);
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    return { kind: classifyFsError(err), path };
  }
  return { kind: "written", path, size: bytes.length };
}
