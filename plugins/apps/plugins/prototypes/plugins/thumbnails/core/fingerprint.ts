import { createSha256 } from "@plugins/packages/plugins/string-hash/core";

/** One file of a prototype folder, as the fingerprint reads it. */
export interface FingerprintedFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * A prototype folder's content fingerprint — the thumbnail cache's key: sha256
 * over every file's name, NUL, its bytes, NUL, in sorted name order.
 *
 * The digest is the cache's KEY, so its byte stream is frozen: it is the same
 * stream `node:crypto` hashed before this ran on every host (`string-hash`'s
 * `createSha256`), so every PNG already cached still hits. Pure, over bytes in
 * hand, so whoever holds a folder's files — the server over its file root, a
 * check over a seed on disk — names its picture the same way.
 */
export function fingerprintFiles(files: readonly FingerprintedFile[]): string {
  const hash = createSha256();
  for (const file of [...files].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    hash.update(file.name).update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return hash.hex();
}
