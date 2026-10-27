import {
  joinRel,
  type Missing,
  type Mount,
  type RelPath,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { fingerprintFiles, type FingerprintedFile } from "../../core";

/** A folder's fingerprint, or the folder (or a file in it) gone mid-read. */
export type FolderFingerprint =
  { readonly kind: "hashed"; key: string } | Missing;

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
): Promise<FolderFingerprint> {
  const listed = await mount.list(dir);
  if (listed.kind === "missing") return listed;
  const files: FingerprintedFile[] = [];
  for (const entry of listed.entries) {
    if (entry.kind !== "file") continue;
    const read = await mount.read(joinRel(dir, entry.name));
    if (read.kind === "missing") return read;
    files.push({
      name: entry.name,
      bytes: new Uint8Array(await read.blob.arrayBuffer()),
    });
  }
  return { kind: "hashed", key: fingerprintFiles(files) };
}
