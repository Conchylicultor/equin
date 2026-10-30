import { stat } from "node:fs/promises";
import { withHeavyReadSlot } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import { createInflight } from "@plugins/packages/plugins/inflight/core";
import type { HostFsEntry } from "../../../core";
import { byName } from "../entry";
import { isHiddenName } from "../path";
import type {
  ArchiveFormat,
  ArchiveMember,
  ArchiveUnreadable,
} from "./registry";
import type { UserPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/** More members than this is `too-many-entries`: the index is held in memory. */
export const MAX_ARCHIVE_MEMBERS = 200_000;
/** How many archives' indexes stay cached, and how many members all of them may hold. */
const CACHE_ARCHIVES = 16;
const CACHE_MEMBERS = 500_000;

type FileMember = Extract<ArchiveMember, { kind: "file" }>;

/**
 * An archive's contents as host-fs serves them: every member (and every
 * directory a member implies) by its normalised inner path (`""` is the root),
 * and each directory's children sorted like a disk listing.
 */
export interface ArchiveTree {
  entries: ReadonlyMap<string, HostFsEntry>;
  children: ReadonlyMap<string, readonly HostFsEntry[]>;
  files: ReadonlyMap<string, FileMember>;
}

export type ArchiveTreeResult =
  { kind: "ok"; tree: ArchiveTree } | ArchiveUnreadable;

/**
 * A member's name as an inner path: `\` read as `/` (zips written on
 * Windows), empty and `.` segments dropped, no leading or trailing slash.
 * `null` for a name that would climb out of the archive (`..`), which is
 * never listed.
 */
export function normaliseMemberPath(raw: string): string | null {
  const segments = raw
    .replaceAll("\\", "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) return null;
  return segments.join("/");
}

function parentKey(inner: string): string {
  const slash = inner.lastIndexOf("/");
  return slash === -1 ? "" : inner.slice(0, slash);
}

function baseOf(inner: string): string {
  return inner.slice(inner.lastIndexOf("/") + 1);
}

/**
 * macOS's Archive Utility adds a `__MACOSX/` tree of AppleDouble resource
 * forks to every zip it makes; the Finder hides it on extraction, so it is
 * hidden here like a dotfile.
 */
function isHiddenMember(inner: string): boolean {
  return isHiddenName(baseOf(inner)) || inner === "__MACOSX";
}

/**
 * Build the tree host-fs serves from a format's raw member list. Directories
 * a member implies but the archive does not list are synthesised with the
 * archive's own mtime; when a name occurs twice the last one wins (as an
 * extraction would leave it).
 */
export function buildArchiveTree(
  members: readonly ArchiveMember[],
  archiveMtimeMs: number,
): ArchiveTree {
  const entries = new Map<string, HostFsEntry>();
  const files = new Map<string, FileMember>();
  const dirEntry = (inner: string, mtimeMs: number): HostFsEntry => ({
    name: baseOf(inner),
    kind: "dir",
    size: 0,
    mtimeMs,
    hidden: isHiddenMember(inner),
  });
  const ensureParents = (inner: string) => {
    for (let p = parentKey(inner); p !== ""; p = parentKey(p)) {
      if (entries.get(p)?.kind === "dir") return;
      entries.set(p, dirEntry(p, archiveMtimeMs));
      files.delete(p);
    }
  };
  entries.set("", dirEntry("", archiveMtimeMs));
  for (const member of members) {
    const inner = normaliseMemberPath(member.path);
    if (inner === null || inner === "") continue;
    ensureParents(inner);
    if (member.kind === "dir") {
      entries.set(inner, dirEntry(inner, member.mtimeMs));
      files.delete(inner);
      continue;
    }
    entries.set(inner, {
      name: baseOf(inner),
      kind: member.kind,
      size: member.kind === "file" ? member.size : 0,
      mtimeMs: member.mtimeMs,
      hidden: isHiddenMember(inner),
    });
    if (member.kind === "file") files.set(inner, member);
    else files.delete(inner);
  }
  const children = new Map<string, HostFsEntry[]>();
  for (const [inner, entry] of entries) {
    if (entry.kind === "dir" && !children.has(inner)) children.set(inner, []);
    if (inner === "") continue;
    const parent = parentKey(inner);
    const list = children.get(parent);
    if (list) list.push(entry);
    else children.set(parent, [entry]);
  }
  for (const list of children.values()) list.sort(byName);
  return { entries, children, files };
}

interface Cached {
  /** The archive file's identity when it was indexed: any change re-indexes it. */
  key: string;
  result: ArchiveTreeResult;
  members: number;
}

/** Most recently used last. */
const cache = new Map<string, Cached>();
const flights = createInflight();

function remember(file: UserPath, cached: Cached): void {
  cache.delete(file);
  cache.set(file, cached);
  let total = 0;
  for (const c of cache.values()) total += c.members;
  for (const [oldest, c] of cache) {
    if (cache.size <= CACHE_ARCHIVES && total <= CACHE_MEMBERS) break;
    if (oldest === file) break;
    cache.delete(oldest);
    total -= c.members;
  }
}

/**
 * The tree of the archive at `file` (a regular file on disk `format` claims).
 * Cached by the file's identity — inode, size and mtime — so a rewritten
 * archive is re-indexed on its next read, never served stale. Concurrent
 * readers share one index build, which runs under the host-wide heavy-read
 * budget. Throws the raw `stat` error (the caller classifies it).
 */
export async function archiveTree(
  file: UserPath,
  format: ArchiveFormat,
): Promise<ArchiveTreeResult> {
  const st = await stat(file);
  const key = `${format.id}:${st.ino}:${st.size}:${st.mtimeMs}`;
  const hit = cache.get(file);
  if (hit?.key === key) {
    remember(file, hit);
    return hit.result;
  }
  return flights.run(`${file}\0${key}`, async () => {
    const indexed = await withHeavyReadSlot(() =>
      format.index(file, { maxMembers: MAX_ARCHIVE_MEMBERS }),
    );
    const cached: Cached =
      indexed.kind === "ok"
        ? {
            key,
            result: {
              kind: "ok",
              tree: buildArchiveTree(indexed.members, st.mtimeMs),
            },
            members: indexed.members.length,
          }
        : { key, result: indexed, members: 0 };
    remember(file, cached);
    return cached.result;
  });
}
