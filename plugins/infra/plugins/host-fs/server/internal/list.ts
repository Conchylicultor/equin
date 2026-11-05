import { readdir, stat } from "@plugins/packages/plugins/timed-fs/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { join } from "node:path";
import { type HostFsEntry, type HostFsListResult } from "../../core";
import { locateHostDir } from "./archive/locate";
import { listArchiveDir } from "./archive/read";
import { byName, describeEntry } from "./entry";
import { classifyFsError, parentOf } from "./path";
import {
  asUserPath,
  type UserPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * At most this many entries are described (`lstat`, plus a symlink's
 * `readlink` + `stat`) at once, across every listing in the process. A folder
 * of thousands (`/tmp`) otherwise fans out one `lstat` per entry in one go,
 * and every other filesystem read — a tree's peeks — queues behind the flood.
 */
const DESCRIBE_CONCURRENCY = 16;
const describing = createSemaphore(DESCRIBE_CONCURRENCY);

/**
 * List the absolute directory `path`. A symlink to a directory lists its
 * target. An entry that vanishes between `readdir` and its `lstat` is skipped
 * (it is no longer there); an entry that cannot be described because the
 * directory grants read but not search permission makes the whole listing
 * `denied` — a listing never invents metadata.
 */
export async function listHostDir(path: UserPath): Promise<HostFsListResult> {
  try {
    const st = await stat(path);
    if (!st.isDirectory()) return { kind: "not-a-dir", path };
    const described = await describeChildren(path, await readdir(path));
    return {
      kind: "ok",
      path,
      parent: parentOf(path),
      entries: [...described.values()]
        .filter((e): e is HostFsEntry => e.kind !== "vanished")
        .sort(byName),
    };
  } catch (err) {
    return { kind: classifyFsError(err), path };
  }
}

/** A child that was named but is no longer there when described. */
export type Vanished = { kind: "vanished" };

/**
 * Describe the children `names` of the absolute folder `dir`, a bounded number
 * at a time: each one's entry, or `vanished` when it is not there (any other
 * failure — a folder granting read but not search — rejects).
 */
export async function describeChildren(
  dir: UserPath,
  names: Iterable<string>,
): Promise<Map<string, HostFsEntry | Vanished>> {
  return new Map(
    await Promise.all(
      [...new Set(names)].map(
        async (name) =>
          [name, await describing.run(() => describeChild(dir, name))] as const,
      ),
    ),
  );
}

async function describeChild(
  dir: UserPath,
  name: string,
): Promise<HostFsEntry | Vanished> {
  try {
    return await describeEntry(asUserPath(join(dir, name)), name);
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
export async function listHostPath(path: UserPath): Promise<HostFsListResult> {
  const located = await locateHostDir(path);
  return located.kind === "archive"
    ? listArchiveDir(path, located)
    : listHostDir(path);
}
