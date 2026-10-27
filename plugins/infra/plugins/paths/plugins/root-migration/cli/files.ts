import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { Move } from "./plan";
import {
  cacheEntryOf,
  isHistoryRecord,
  isSkippedTree,
  looksLikeText,
  pathOccurrences,
  rewriteText,
} from "./rewrite";

// The files under the (moved) data root that store an old path, by one walk —
// run once to rewrite and once more, read-only, as the leftover scan. Both go
// through `visit`, so what the rewrite fixes and what the scan counts are the
// same set by construction.

export interface FileFindings {
  /** Text files holding an old path (rewritten in place by the apply pass). */
  text: string[];
  /** Links whose absolute target is under an old prefix (re-pointed). */
  links: string[];
  /** Cache entries holding an old path anywhere (dropped whole). */
  cacheEntries: string[];
  /**
   * Binaries outside `cache/` holding an old path. Not editable and almost
   * always a build-path string (a compiled release's debug info), so they are
   * reported but do not keep the legacy name alive.
   */
  binaries: string[];
}

function holdsOldPath(text: string, moves: readonly Move[]): boolean {
  return moves.some(({ from }) => {
    const re = pathOccurrences(from);
    return re.test(text);
  });
}

function holdsOldBytes(bytes: Uint8Array, moves: readonly Move[]): boolean {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return moves.some(({ from }) => buf.includes(from));
}

function linkTarget(target: string, moves: readonly Move[]): string | null {
  if (!isAbsolute(target)) return null;
  const rewritten = rewriteText(target, moves);
  return rewritten === target ? null : rewritten;
}

/**
 * Walk `root` (never following a link) and classify every stored old path.
 * With `apply`, rewrite text files in place (same inode, same mode), re-point
 * links, and drop the cache entries that hold one.
 */
export function visitFiles(
  root: string,
  moves: readonly Move[],
  apply: boolean,
): FileFindings {
  const findings: FileFindings = {
    text: [],
    links: [],
    cacheEntries: [],
    binaries: [],
  };
  const cacheHits = new Set<string>();

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (isSkippedTree(rel) || isHistoryRecord(rel)) continue;
      const cacheEntry = cacheEntryOf(rel);
      if (cacheEntry !== null && cacheHits.has(cacheEntry)) continue;
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(path);
        const next = linkTarget(target, moves);
        if (next === null) continue;
        if (cacheEntry !== null) {
          cacheHits.add(cacheEntry);
          continue;
        }
        findings.links.push(rel);
        if (apply) {
          unlinkSync(path);
          symlinkSync(next, path);
        }
        continue;
      }
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = readFileSync(path);
      if (!holdsOldBytes(bytes, moves)) continue;
      if (cacheEntry !== null) {
        cacheHits.add(cacheEntry);
        continue;
      }
      if (!looksLikeText(bytes)) {
        findings.binaries.push(rel);
        continue;
      }
      const text = bytes.toString("utf8");
      if (!holdsOldPath(text, moves)) continue;
      findings.text.push(rel);
      if (apply) {
        const mode = lstatSync(path).mode;
        writeFileSync(path, rewriteText(text, moves), { mode });
      }
    }
  };
  walk(root);

  findings.cacheEntries = [...cacheHits].sort();
  if (apply) {
    for (const entry of findings.cacheEntries) {
      rmSync(join(root, entry), { recursive: true, force: true });
    }
  }
  return findings;
}
