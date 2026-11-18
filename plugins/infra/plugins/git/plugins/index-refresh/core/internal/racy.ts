/**
 * What a checkout's index says about how far git can trust it: how many
 * entries it holds, and how many of them are RACILY CLEAN — their file's mtime
 * is not strictly older, in whole seconds, than the index file itself.
 */
export interface IndexRacyCount {
  entries: number;
  racy: number;
}

/** Bytes of one entry before its path: stat data, oid (SHA-1), flags. */
const FIXED_BYTES = 62;
const EXTENDED_FLAG = 0x4000;
const NAME_MASK = 0xfff;

/**
 * Count the racily-clean entries of a git index (`bytes`, the whole file),
 * against the index file's own mtime in whole seconds.
 *
 * Why it matters: git cannot tell a file edited in the same second as the
 * index was written from an untouched one by its stat data, so every read —
 * `git status`, `git diff <rev>` — re-reads and hashes each such file
 * (`is_racy_timestamp`: `index.sec <= entry.mtime.sec`; Apple git has no
 * USE_NSEC, so seconds only). A whole-tree write (a checkout, a rebase, a
 * switch) leaves thousands of them, and since none of our reads may write the
 * index (spawn's `GIT_OPTIONAL_LOCKS=0`), they stay until something rewrites
 * it: one checkout held 6,857, and each `git diff` there took 0.6 s warm and
 * 8 s cold for a branch with no change at all. An entry git smudged when it
 * wrote the index (racy then, size zeroed) has the same mtime, so it counts too.
 *
 * Index versions 2, 3 and 4 (v4's prefix-compressed paths), SHA-1 object ids.
 * Throws on anything else: a count it cannot vouch for is no answer.
 */
export function countRacyEntries(
  bytes: Uint8Array,
  indexMtimeSec: number,
): IndexRacyCount {
  let racy = 0;
  const { entries } = walkEntries(bytes, (mtimeSec) => {
    if (mtimeSec >= indexMtimeSec) racy++;
  });
  return { entries, racy };
}

/** SHA-1 trailer of the index file: the extensions end before it. */
const TRAILER_BYTES = 20;
const FSMN = 0x46534d4e; /* "FSMN" */

/**
 * The fsmonitor token a git index carries (its `FSMN` extension), or null when
 * it has none — written by any git that ran with `core.fsmonitor` on and wrote
 * the index. git asks its fsmonitor "what changed since this token?", so the
 * token is what makes a read cost O(changes): a token the running daemon did
 * not issue (it was restarted) is answered "everything", a full scan, on every
 * read until the index is written again — which no read of ours does
 * (`GIT_OPTIONAL_LOCKS=0`). `infra/git/fsmonitor` reads it to tell.
 *
 * Version 2 (a string token, the builtin daemon's
 * `builtin:<n>.<pid>.<started>:<seq>`) is returned as written; version 1 (a
 * hook's nanosecond timestamp) as `v1:<ns>`.
 */
export function readIndexFsmonitorToken(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = walkEntries(bytes, () => {}).end;
  const end = bytes.byteLength - TRAILER_BYTES;
  while (p + 8 <= end) {
    const sig = view.getUint32(p);
    const size = view.getUint32(p + 4);
    const data = p + 8;
    if (data + size > end) {
      throw new Error(
        `[index-refresh] index extension at ${p} overruns the file (${size} bytes)`,
      );
    }
    if (sig === FSMN) {
      const version = view.getUint32(data);
      if (version === 1) return `v1:${view.getBigUint64(data + 4)}`;
      if (version === 2) {
        const nul = bytes.indexOf(0, data + 4);
        if (nul < 0 || nul >= data + size) {
          throw new Error("[index-refresh] FSMN token unterminated");
        }
        return new TextDecoder().decode(bytes.subarray(data + 4, nul));
      }
      throw new Error(`[index-refresh] unsupported FSMN version ${version}`);
    }
    p = data + size;
  }
  return null;
}

/**
 * Walk a git index's entries (versions 2, 3 and 4, SHA-1 ids), calling
 * `onEntry` with each entry's mtime seconds; answers the entry count and the
 * offset the extensions start at. Throws on anything it cannot read.
 */
function walkEntries(
  bytes: Uint8Array,
  onEntry: (mtimeSec: number) => void,
): { entries: number; end: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || view.getUint32(0) !== 0x44495243 /* DIRC */) {
    throw new Error("[index-refresh] not a git index (no DIRC signature)");
  }
  const version = view.getUint32(4);
  if (version < 2 || version > 4) {
    throw new Error(`[index-refresh] unsupported index version ${version}`);
  }
  const entries = view.getUint32(8);
  let p = 12;
  for (let i = 0; i < entries; i++) {
    if (p + FIXED_BYTES > bytes.byteLength) {
      throw new Error(`[index-refresh] index truncated at entry ${i}`);
    }
    onEntry(view.getUint32(p + 8));
    const flags = view.getUint16(p + 60);
    const head = FIXED_BYTES + (version >= 3 && flags & EXTENDED_FLAG ? 2 : 0);
    let q = p + head;
    if (version === 4) {
      // A varint (how much of the previous path to drop), then the
      // NUL-terminated rest of this path; no padding.
      while (bytes[q]! & 0x80) q++;
      q++;
      q = nulAfter(bytes, q, i) + 1;
      p = q;
    } else {
      const nameLen = flags & NAME_MASK;
      const len = nameLen < NAME_MASK ? nameLen : nulAfter(bytes, q, i) - q;
      // The path, then 1–8 NULs padding the entry to a multiple of 8.
      p += (head + len + 8) & ~7;
    }
  }
  return { entries, end: p };
}

function nulAfter(bytes: Uint8Array, from: number, entry: number): number {
  const at = bytes.indexOf(0, from);
  if (at < 0) {
    throw new Error(
      `[index-refresh] index path unterminated at entry ${entry}`,
    );
  }
  return at;
}
