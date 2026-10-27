// One prototype folder's signature — every file in it with its size and mtime —
// and the short `rev` derived from it. `shared/`, not `server/`, because the
// lister (`list-metas.ts`, also run by the CLI) stamps each meta with its `rev`,
// and the server's watcher compares the same signatures to decide what moved.

import { sha1Hex } from "@plugins/packages/plugins/string-hash/core";
import {
  relPath,
  type Mount,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";

/** One file of a prototype folder, as the signature sees it. */
export interface FolderFile {
  name: string;
  size: number;
  mtimeMs: number;
}

/**
 * Every file in one prototype folder with its size and mtime, sorted by name —
 * dot-files and sub-folders skipped. `null` when the folder is gone (removed
 * mid-walk).
 *
 * `(size, mtime)` rather than content: prototypes live outside every checkout
 * (nothing ever rewrites their mtimes behind the author's back), a rewrite the
 * author makes always moves the mtime, and the watcher re-reads this on a 30s
 * timer — so it has to stay one listing.
 */
export async function readFolderFiles(
  mount: Mount,
  dirName: string,
): Promise<FolderFile[] | null> {
  const listed = await mount.list(relPath(dirName));
  if (listed.kind === "missing") return null;
  return listed.entries
    .filter((e) => e.kind === "file" && !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ name: e.name, size: e.size, mtimeMs: e.mtimeMs }));
}

/** A folder's files as `name:size:mtimeMs`, one per line — its signature. */
export function signatureOfFiles(files: FolderFile[]): string {
  return files.map((f) => `${f.name}:${f.size}:${f.mtimeMs}`).join("\n");
}

/** {@link readFolderFiles} as its signature string; `null` when the folder is gone. */
export async function readFolderSignature(
  mount: Mount,
  dirName: string,
): Promise<string | null> {
  const files = await readFolderFiles(mount, dirName);
  return files === null ? null : signatureOfFiles(files);
}

/**
 * A short, stable name for a folder signature — `PrototypeMeta.rev`. The same
 * bytes on disk give the same rev in every process and across restarts, so a
 * live frame keyed on it reloads only when ITS files really changed.
 */
export function revOfSignature(signature: string): string {
  return sha1Hex(signature).slice(0, 12);
}
