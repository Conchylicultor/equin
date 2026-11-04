import { sha1Hex, sha256Hex } from "@plugins/packages/plugins/string-hash/core";

/**
 * A record key: the hash of every input its value is a function of, each part
 * written with its length so no two part lists can spell the same string.
 *
 * What goes in is the caller's to get right, and there is one rule: a part is
 * a CONTENT identity (a blob id, another key, a version string), never a time,
 * a path on this machine or a counter. That is what lets one store serve every
 * worktree.
 */
export function recordKey(...parts: readonly string[]): string {
  let text = "";
  for (const p of parts) text += `${p.length}:${p}\n`;
  return sha256Hex(text);
}

/**
 * The git blob id of `content` — what `git hash-object` answers for a file
 * holding it — for a file the build wrote after its snapshot was taken, or one
 * git does not track (a gitignored generated module a barrel imports).
 */
export function gitBlobId(content: string): string {
  const bytes = new TextEncoder().encode(content).length;
  return sha1Hex(`blob ${bytes}\0${content}`);
}
