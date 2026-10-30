import { lstat, stat } from "node:fs/promises";
import { basename, relative } from "node:path";
import { classifyFsError, parentOf } from "../path";
import { archiveFormatFor, type ArchiveFormat } from "./registry";
import type { UserPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * Where a host path's bytes live: on disk, or inside an archive file on disk
 * (`inner` is the member path under it, `""` for the archive's root).
 */
export type HostLocation =
  | { kind: "disk"; path: UserPath }
  | { kind: "archive"; file: UserPath; format: ArchiveFormat; inner: string };

/**
 * Locate the absolute host path `path`. A path that exists on disk is a disk
 * path — so a real directory named `x.zip` stays a directory and nothing that
 * worked before an archive format was registered changes. Only a path that is
 * not there is looked for inside an archive: the nearest ancestor whose name a
 * format claims and which is a regular file. A path no archive explains stays
 * a disk path, and the caller's own read reports it `missing`.
 *
 * An archive inside an archive is not browsed: its members are not found, so
 * a path through one is `missing`.
 */
export async function locateHostPath(path: UserPath): Promise<HostLocation> {
  if (await existsOnDisk(path)) return { kind: "disk", path };
  for (let dir = parentOf(path); dir !== null; dir = parentOf(dir)) {
    const format = archiveFormatFor(basename(dir));
    if (format === undefined || (await kindAt(dir)) !== "file") continue;
    return { kind: "archive", file: dir, format, inner: relative(dir, path) };
  }
  return { kind: "disk", path };
}

/**
 * The location `list` reads: like {@link locateHostPath}, except that an
 * archive file on disk is listed as its own root.
 */
export async function locateHostDir(path: UserPath): Promise<HostLocation> {
  const located = await locateHostPath(path);
  if (located.kind === "archive") return located;
  const format = archiveFormatFor(basename(path));
  if (format !== undefined && (await kindAt(path)) === "file") {
    return { kind: "archive", file: path, format, inner: "" };
  }
  return located;
}

/** `false` only for ENOENT / ENOTDIR: anything else is the caller's own read to report. */
async function existsOnDisk(path: UserPath): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    return classifyFsError(err) !== "missing";
  }
}

/**
 * What is at `path`, symlinks followed. Only a `file` is an archive to read
 * into; a missing or denied one explains nothing about the path below it.
 */
async function kindAt(
  path: UserPath,
): Promise<"file" | "not-a-file" | "missing" | "denied"> {
  try {
    return (await stat(path)).isFile() ? "file" : "not-a-file";
  } catch (err) {
    return classifyFsError(err);
  }
}
