import {
  joinRel,
  type FileEntry,
  type Missing,
  type Mount,
  type RelPath,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { fingerprintFiles, type FingerprintedFile } from "../../core";

/** A folder's fingerprint, or the folder (or a file in it) gone mid-read. */
export type FolderFingerprint =
  { readonly kind: "hashed"; key: string } | Missing;

/**
 * What a folder's fingerprint was last hashed to, by its LISTING (every file's
 * name, size, mtime and birthtime) — so a folder whose listing has not moved is
 * not read and hashed again. The key is still the content hash; the memo only
 * says which listing it was computed at.
 */
export interface FingerprintMemo {
  /** The key hashed at exactly this listing, if one is known. */
  known(dir: RelPath, listing: string): string | undefined;
  /** Remember the key hashed from bytes read at this listing. */
  learned(dir: RelPath, listing: string, key: string): void;
}

/** Hash every time — a one-off reader (the CLI over another tree). */
export const noFingerprintMemo: FingerprintMemo = {
  known: () => undefined,
  learned: () => {},
};

/**
 * How old every file's mtime and birthtime must be before its listing may vouch
 * for its bytes. A write in the same timestamp tick as the listing could change
 * the bytes without moving the listing (git's "racy" entries), so a listing of
 * a just-written file is hashed now and not remembered. 2 s covers the coarsest
 * mtime a host filesystem keeps (FAT); APFS keeps nanoseconds.
 */
const SETTLED_MS = 2000;

/**
 * A folder's content fingerprint: sha256 over every file's name and bytes, in
 * sorted order.
 *
 * Content rather than `(mtime, size)` on purpose. The thumbnail cache is
 * host-global, so hashing content lets two worktrees holding the same prototype
 * share one rendered PNG, and a `git checkout` that rewrites mtimes without
 * changing bytes does not trigger a pointless re-render. It costs one read of a
 * folder that is ~20 KB by contract.
 *
 * The `memo` skips that read when the folder's listing is exactly the one a
 * previous hash was taken at — the listing moves on any write (mtime), any
 * replace (birthtime) and any file added or removed, so an unchanged listing
 * means unchanged bytes. In doubt it hashes: a listing of a file written in the
 * last {@link SETTLED_MS} is never remembered, and a listing it does not know
 * is never trusted, and a file that moved between the listing and its read is
 * not remembered. A rewrite that moved mtimes but not bytes re-hashes to the
 * same key, so it still does not re-render. What it cannot see is a write that
 * deliberately restores a file's size, mtime and birthtime (same inode,
 * `touch -r` after an edit) — nothing in the prototypes' write paths does.
 *
 * The digest is the cache's KEY, so its byte stream is frozen
 * (`core`'s `fingerprintFiles`, which every reader of a folder shares).
 *
 * Flat by construction — `prototypes:self-contained` rejects a subdirectory —
 * so a shallow read is the whole folder. A directory entry that somehow exists
 * is skipped rather than folded in as a name with no bytes.
 *
 * Over a `Mount` rather than the prototypes root, so nothing about the
 * prototypes tree reaches into it and a test can hand it any folder. `missing`
 * when the folder — or a file listed in it — is gone before it was read: a
 * removal racing the hash, which the watcher reports next.
 */
export async function fingerprintFolder(
  mount: Mount,
  dir: RelPath,
  memo: FingerprintMemo,
): Promise<FolderFingerprint> {
  const listedAt = Date.now();
  const listed = await mount.list(dir);
  if (listed.kind === "missing") return listed;
  const entries = listed.entries.filter((entry) => entry.kind === "file");
  const listing = listingOf(entries);

  const known = memo.known(dir, listing);
  if (known !== undefined) return { kind: "hashed", key: known };

  const files: FingerprintedFile[] = [];
  // Whether the bytes read are the ones the listing describes: a file
  // rewritten between the listing and its read must not be remembered under
  // the old listing.
  let unmoved = true;
  for (const entry of entries) {
    const read = await mount.read(joinRel(dir, entry.name));
    if (read.kind === "missing") return read;
    if (!sameFile(read.entry, entry)) unmoved = false;
    files.push({
      name: entry.name,
      bytes: new Uint8Array(await read.blob.arrayBuffer()),
    });
  }
  const key = fingerprintFiles(files);
  const settled = entries.every(
    (entry) =>
      entry.mtimeMs < listedAt - SETTLED_MS &&
      entry.birthtimeMs < listedAt - SETTLED_MS,
  );
  if (settled && unmoved) memo.learned(dir, listing, key);
  return { kind: "hashed", key };
}

function sameFile(a: FileEntry, b: FileEntry): boolean {
  return (
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.birthtimeMs === b.birthtimeMs
  );
}

/** A folder's files as one comparable string: name, size, mtime, birthtime. */
function listingOf(files: readonly FileEntry[]): string {
  return JSON.stringify(
    [...files]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((f) => [f.name, f.size, f.mtimeMs, f.birthtimeMs]),
  );
}
