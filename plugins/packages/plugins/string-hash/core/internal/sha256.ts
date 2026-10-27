import { sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * SHA-256 of `text`'s UTF-8 bytes, as lowercase hex — synchronous and in plain
 * JS (`@noble/hashes`), so every host computes it: byte-for-byte the digest
 * `createHash("sha256").update(text).digest("hex")` gives on the Bun server, and
 * the same value in a browser page, where `crypto.subtle.digest` is async only.
 *
 * The signatures stored in the DB (derived views, rollups, triggers, query
 * fingerprints) are built on it, so switching a caller from `node:crypto` to
 * this rebuilds nothing.
 */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/** An incremental SHA-256 over strings (as UTF-8) and bytes. */
export interface Sha256Hasher {
  update(data: string | Uint8Array): Sha256Hasher;
  /** The digest as lowercase hex; the hasher is spent after. */
  hex(): string;
}

/**
 * An incremental SHA-256: the same digest as `createHash("sha256")` fed the
 * same `update`s (a string as its UTF-8 bytes) and read with
 * `.digest("hex")` — so a content hash persisted as a cache key (a folder's
 * names and bytes) keeps its value when its caller leaves `node:crypto`.
 */
export function createSha256(): Sha256Hasher {
  const hash = sha256.create();
  const hasher: Sha256Hasher = {
    update(data) {
      hash.update(typeof data === "string" ? utf8ToBytes(data) : data);
      return hasher;
    },
    hex() {
      return bytesToHex(hash.digest());
    },
  };
  return hasher;
}

/**
 * SHA-1 of `text`'s UTF-8 bytes, as lowercase hex — identical to
 * `createHash("sha1").update(text).digest("hex")`. For a value already
 * persisted or compared as a SHA-1 (a name, a revision stamp), never for
 * security: SHA-1 is broken against forged collisions.
 */
export function sha1Hex(text: string): string {
  return bytesToHex(sha1(utf8ToBytes(text)));
}
