import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { basename } from "node:path";
import type { HostFsReadAccess, HostFsStatResult } from "../../core";
import { locateHostPath } from "./archive/locate";
import { statArchiveMember } from "./archive/read";
import { describeEntry } from "./entry";
import { classifyFsError, parentOf } from "./path";
import type { UserPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/** Describe the absolute host path `path` (the root `/` is named `/`). */
export async function statHostPath(path: UserPath): Promise<HostFsStatResult> {
  try {
    const entry = await describeEntry(path, basename(path) || "/");
    // An unresolvable symlink has no contents to read.
    if (entry.kind === "symlink")
      return { kind: "ok", path, parent: parentOf(path), entry };
    const read = await readAccess(path);
    return { kind: "ok", path, parent: parentOf(path), entry, read };
  } catch (err) {
    return { kind: classifyFsError(err), path };
  }
}

/**
 * Whether the account can read `path`'s contents. EPERM is macOS privacy
 * protection (TCC: a folder like ~/Downloads the equin app is not allowed
 * into), EACCES the path's own permissions. A path gone in between rethrows
 * as `missing` through the caller's classification.
 */
async function readAccess(path: UserPath): Promise<HostFsReadAccess> {
  try {
    await access(path, constants.R_OK);
    return "readable";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return "macos-privacy";
    if (code === "EACCES") return "permissions";
    throw err;
  }
}

/** Describe the absolute host path `path` — on disk, or a member of an archive. */
export async function statHostOrArchivePath(
  path: UserPath,
): Promise<HostFsStatResult> {
  const located = await locateHostPath(path);
  return located.kind === "archive"
    ? statArchiveMember(path, located)
    : statHostPath(path);
}
