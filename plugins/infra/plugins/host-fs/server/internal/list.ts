import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type HostFsEntry, type HostFsListResult } from "../../core";
import { locateHostDir } from "./archive/locate";
import { listArchiveDir } from "./archive/read";
import { byName, describeEntry } from "./entry";
import { classifyFsError, parentOf } from "./path";

/**
 * List the absolute directory `path`. A symlink to a directory lists its
 * target. An entry that vanishes between `readdir` and its `lstat` is skipped
 * (it is no longer there); an entry that cannot be described because the
 * directory grants read but not search permission makes the whole listing
 * `denied` — a listing never invents metadata.
 */
export async function listHostDir(path: string): Promise<HostFsListResult> {
  try {
    const st = await stat(path);
    if (!st.isDirectory()) return { kind: "not-a-dir", path };
    const names = await readdir(path);
    const entries = await Promise.all(
      names.map((name) => describeChild(path, name)),
    );
    return {
      kind: "ok",
      path,
      parent: parentOf(path),
      entries: entries
        .filter((e): e is HostFsEntry => e.kind !== "vanished")
        .sort(byName),
    };
  } catch (err) {
    return { kind: classifyFsError(err), path };
  }
}

type Vanished = { kind: "vanished" };

async function describeChild(
  dir: string,
  name: string,
): Promise<HostFsEntry | Vanished> {
  try {
    return await describeEntry(join(dir, name), name);
  } catch (err) {
    // ENOENT here is a race with a concurrent delete: the entry is gone.
    // EACCES/EPERM propagates and denies the listing.
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "vanished" };
    throw err;
  }
}

/**
 * List the absolute host path `path`: a directory on disk, an archive file on
 * disk (its root), or a directory inside an archive.
 */
export async function listHostPath(path: string): Promise<HostFsListResult> {
  const located = await locateHostDir(path);
  return located.kind === "archive"
    ? listArchiveDir(path, located)
    : listHostDir(path);
}
