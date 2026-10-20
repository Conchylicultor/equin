import type { Stats } from "node:fs";
import { lstat, readlink, stat } from "node:fs/promises";
import {
  compareHostFsNames,
  type HostFsEntry,
  type HostFsEntryKind,
} from "../../core";
import { archiveFormatFor } from "./archive/registry";
import { classifyFsError, isHiddenName } from "./path";

/** How every listing orders its entries: `compareHostFsNames` of their names. */
export const byName = (a: { name: string }, b: { name: string }): number =>
  compareHostFsNames(a.name, b.name);

function kindOf(st: Stats): HostFsEntryKind {
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return "other";
}

/** The entry's creation and access times, from the same `Stats` as its mtime. */
function times(st: Stats): Pick<HostFsEntry, "birthtimeMs" | "atimeMs"> {
  // Linux filesystems without statx birth time report 0: not recorded, not 1970.
  return {
    atimeMs: st.atimeMs,
    ...(st.birthtimeMs > 0 ? { birthtimeMs: st.birthtimeMs } : {}),
  };
}

/**
 * The `archive` mark of a file named `name`: present when a registered format
 * claims it. A name check only, so a listing costs no extra I/O.
 */
function archiveMark(
  kind: HostFsEntryKind,
  name: string,
): Pick<HostFsEntry, "archive"> {
  if (kind !== "file") return {};
  const format = archiveFormatFor(name);
  return format === undefined ? {} : { archive: { format: format.id } };
}

/**
 * Describe the entry at `path` (named `name`), judged by what it resolves to.
 * A symlink is followed: a link to a directory is a `dir`, to a file a `file`,
 * and its own text rides along as `symlinkTarget`. A link that cannot be
 * followed (dangling, a loop, a denied target) is a `symlink` described by the
 * link itself — a fact about the link, not a failure of the listing.
 *
 * Throws the raw `lstat` error for the entry itself, so each caller decides
 * what a vanished or unreadable entry means for its own answer.
 */
export async function describeEntry(
  path: string,
  name: string,
): Promise<HostFsEntry> {
  const own = await lstat(path);
  const hidden = isHiddenName(name);
  if (!own.isSymbolicLink()) {
    const kind = kindOf(own);
    return {
      name,
      kind,
      size: own.size,
      mtimeMs: own.mtimeMs,
      ...times(own),
      hidden,
      ...archiveMark(kind, name),
    };
  }
  const symlinkTarget = await readlink(path);
  const target = await followLink(path);
  if (target.kind === "unresolvable") {
    return {
      name,
      kind: "symlink",
      size: own.size,
      mtimeMs: own.mtimeMs,
      ...times(own),
      hidden,
      symlinkTarget,
    };
  }
  const st = target.stats;
  const kind = kindOf(st);
  return {
    name,
    kind,
    size: st.size,
    mtimeMs: st.mtimeMs,
    ...times(st),
    hidden,
    symlinkTarget,
    ...archiveMark(kind, name),
  };
}

/** What a symlink resolves to, or that it resolves to nothing readable. */
export type FollowResult =
  { kind: "resolved"; stats: Stats } | { kind: "unresolvable" };

export async function followLink(path: string): Promise<FollowResult> {
  try {
    return { kind: "resolved", stats: await stat(path) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP")
      return { kind: "unresolvable" };
    // missing / denied target → the link is unresolvable; anything else rethrows.
    classifyFsError(err);
    return { kind: "unresolvable" };
  }
}
