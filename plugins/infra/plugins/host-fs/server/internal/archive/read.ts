import {
  HOST_FS_TEXT_MAX_BYTES,
  type HostFsArchiveReason,
  type HostFsListResult,
  type HostFsStatResult,
  type HostFsTextResult,
  type HostFsWithin,
} from "../../../core";
import { classifyFsError, parentOf } from "../path";
import { decodeTextBytes } from "../decode";
import type { HostLocation } from "./locate";
import type { MemberBytes } from "./registry";
import { archiveTree, type ArchiveTree } from "./tree";

type InArchive = Extract<HostLocation, { kind: "archive" }>;
type OpenedMember = Extract<MemberBytes, { kind: "ok" }>;

function withinOf(at: InArchive): HostFsWithin {
  return { archive: at.file, format: at.format.id };
}

function unreadable(path: string, at: InArchive, reason: HostFsArchiveReason) {
  return {
    kind: "unreadable-archive" as const,
    path,
    archive: at.file,
    reason,
  };
}

/**
 * Run `read` against the archive's tree, turning an unreadable archive into
 * its typed arm and a missing / denied archive file into `missing` / `denied`.
 */
async function withTree<R>(
  path: string,
  at: InArchive,
  read: (tree: ArchiveTree) => R | Promise<R>,
): Promise<
  | R
  | ReturnType<typeof unreadable>
  | { kind: "missing" | "denied"; path: string }
> {
  try {
    const result = await archiveTree(at.file, at.format);
    if (result.kind === "unreadable")
      return unreadable(path, at, result.reason);
    return await read(result.tree);
  } catch (err) {
    return { kind: classifyFsError(err), path };
  }
}

/** List the directory `at.inner` of an archive (`""` is its root). */
export function listArchiveDir(
  path: string,
  at: InArchive,
): Promise<HostFsListResult> {
  return withTree(path, at, (tree): HostFsListResult => {
    const entries = tree.children.get(at.inner);
    if (entries !== undefined) {
      return {
        kind: "ok",
        path,
        parent: parentOf(path),
        entries: [...entries],
        within: withinOf(at),
      };
    }
    return tree.entries.has(at.inner)
      ? { kind: "not-a-dir", path }
      : { kind: "missing", path };
  });
}

/** Describe the member `at.inner` of an archive. */
export function statArchiveMember(
  path: string,
  at: InArchive,
): Promise<HostFsStatResult> {
  return withTree(path, at, (tree): HostFsStatResult => {
    const entry = tree.entries.get(at.inner);
    if (entry === undefined) return { kind: "missing", path };
    return {
      kind: "ok",
      path,
      parent: parentOf(path),
      entry,
      within: withinOf(at),
    };
  });
}

/**
 * The bytes of the file member `at.inner`, or why there are none. A directory
 * (or a symlink / device member) is `not-a-file`.
 */
export function openArchiveMember(
  path: string,
  at: InArchive,
): Promise<
  | OpenedMember
  | ReturnType<typeof unreadable>
  | { kind: "missing" | "denied" | "not-a-file"; path: string }
> {
  return withTree(
    path,
    at,
    async (
      tree,
    ): Promise<
      | OpenedMember
      | ReturnType<typeof unreadable>
      | { kind: "missing" | "not-a-file"; path: string }
    > => {
      const member = tree.files.get(at.inner);
      if (member === undefined) {
        return tree.entries.has(at.inner)
          ? { kind: "not-a-file", path }
          : { kind: "missing", path };
      }
      const bytes = await member.open();
      return bytes.kind === "unreadable"
        ? unreadable(path, at, bytes.reason)
        : bytes;
    },
  );
}

/**
 * zlib reports a malformed compressed stream through an error whose `code`
 * starts with `Z_` (`Z_DATA_ERROR`, `Z_BUF_ERROR`): that is a corrupt member.
 */
export function isCorruptStream(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && code.startsWith("Z_");
}

/** Read the member `at.inner` as text, its size gated before it is decompressed. */
export async function readArchiveText(
  path: string,
  at: InArchive,
): Promise<HostFsTextResult> {
  const sized = await statArchiveMember(path, at);
  if (sized.kind !== "ok") return sized;
  if (sized.entry.kind !== "file") return { kind: "not-a-file", path };
  if (sized.entry.size > HOST_FS_TEXT_MAX_BYTES)
    return { kind: "too-large", path, size: sized.entry.size };
  const opened = await openArchiveMember(path, at);
  if (opened.kind !== "ok") return opened;
  let bytes: Uint8Array;
  try {
    bytes = await new Response(opened.body).bytes();
  } catch (err) {
    if (isCorruptStream(err)) return unreadable(path, at, "corrupt");
    throw err;
  }
  return { ...decodeTextBytes(bytes), path, size: bytes.length };
}
