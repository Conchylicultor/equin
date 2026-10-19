// One sha256-of-a-file's-bytes, and the memo that keeps it to one read.
//
// The program key hashes every file its program loaded, twice per run: once to
// decide whether the program changed, and again after the worker, for the
// program it built. The memo keeps that to one read per file.
//
// It is also a CONSISTENCY guarantee: both keys answered from the same reading
// of the tree, so a file edited mid-run cannot make them disagree about what
// the program contained.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/**
 * `absolute path -> sha256 hex of its bytes`, shared for one run.
 *
 * Deliberately a plain `Map`, not a class: it crosses no boundary, it has no
 * invariant beyond "these are hashes of these paths", and every consumer reads
 * it through {@link hashFileCached}.
 */
export type ContentHashMemo = Map<string, string>;

/**
 * sha256 of a file's BYTES; `"-"` for a path that is absent or unreadable.
 *
 * `"-"` is not an absorbed failure: "this path has no content right now" is a
 * legitimate, load-bearing answer here. A file that vanished must hash
 * DIFFERENTLY from any content it ever had, so that a key built over it stops
 * matching — which is exactly what a sentinel that can never collide with a
 * hex digest gives. Anything other than a missing/unreachable path (a bad fd,
 * an I/O error) is a real fault and propagates.
 */
export function hashFileBytes(abs: string): string {
  try {
    if (!statSync(abs).isFile()) return "-";
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EACCES" && code !== "ENOTDIR") throw err;
    return "-";
  }
}

/** {@link hashFileBytes}, reading each path at most once per memo. */
export function hashFileCached(memo: ContentHashMemo, abs: string): string {
  let h = memo.get(abs);
  if (h === undefined) memo.set(abs, (h = hashFileBytes(abs)));
  return h;
}
