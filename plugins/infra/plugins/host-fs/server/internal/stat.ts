import { basename } from "node:path";
import type { HostFsStatResult } from "../../core";
import { locateHostPath } from "./archive/locate";
import { statArchiveMember } from "./archive/read";
import { describeEntry } from "./entry";
import { classifyFsError, parentOf } from "./path";

/** Describe the absolute host path `path` (the root `/` is named `/`). */
export async function statHostPath(path: string): Promise<HostFsStatResult> {
  try {
    const entry = await describeEntry(path, basename(path) || path);
    return { kind: "ok", path, parent: parentOf(path), entry };
  } catch (err) {
    return { kind: classifyFsError(err), path };
  }
}

/** Describe the absolute host path `path` — on disk, or a member of an archive. */
export async function statHostOrArchivePath(
  path: string,
): Promise<HostFsStatResult> {
  const located = await locateHostPath(path);
  return located.kind === "archive"
    ? statArchiveMember(path, located)
    : statHostPath(path);
}
