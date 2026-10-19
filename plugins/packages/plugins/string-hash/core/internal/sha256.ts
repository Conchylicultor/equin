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
