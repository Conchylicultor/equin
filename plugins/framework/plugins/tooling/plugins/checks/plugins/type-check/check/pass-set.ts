// A content-keyed PASS set on disk: "this exact key was recorded green before".
//
// Three of type-check's caches are the same store with different keys — the
// per-file lint result store (key = a file's path and content hash), the
// program-pass record and the signature tables (key = a tsc program's content
// key). Every entry is one small JSON file, the largest a ~200 KB signature
// table, read and parsed whole. All are host-global on purpose: a fresh worktree reuses whatever a sibling recorded
// for an identical key, which is the whole reason the key is content-addressed
// rather than tree- or worktree-scoped.
//
// Sharing one implementation means the atomic write, the age/count bounds and
// the throttled sweep are written once. Each store still declares its OWN data
// dir (`data-dirs/index.ts`), because the reclaim audit describes directories,
// not code.

import { createHash } from "crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import type { DataDir } from "@plugins/infra/plugins/paths/core";

/** How the store is bounded. AGE is the intended evictor; count is a disk backstop. */
export interface PassSetBounds {
  maxAgeMs: number;
  maxEntries: number;
  /** Entries kept when the count backstop trips (oldest evicted first). */
  trimTo: number;
  /**
   * How often the age sweep may run. `openPassSet` prunes eagerly on every
   * open, and the per-entry `statSync` pass is ~95% of that cost (~760 ms at
   * 50k entries) while the readdir is ~40 ms — so against a multi-day age
   * bound, the common path stops after the readdir.
   */
  pruneIntervalMs: number;
}

/** The marker whose mtime dates the last age sweep. Not `.json`, so never an entry. */
const MARKER_FILE = ".last-prune";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface PassSet {
  /** True iff a PASS was recorded for this key. */
  has(key: string): boolean;
  /**
   * The entry recorded for this key, parsed — or undefined when there is none.
   * For a store whose entries carry data (the lint result store), not only a
   * verdict; the caller owns the entry's shape.
   */
  read(key: string): unknown;
  /**
   * Record an entry. Atomic (write-then-rename). `detail` is written into the
   * entry: for a human reading the directory, or for `read`.
   */
  record(key: string, detail: Record<string, unknown>): void;
}

/** Open (and lazily create) a content-keyed PASS set under `dir`. */
export function openPassSet(dir: DataDir, bounds: PassSetBounds): PassSet {
  // A genuinely unwritable home is a real fault and should surface loudly.
  dir.ensure();
  prune(dir, bounds);
  const entryFile = (key: string): string => dir.file(`${sha256(key)}.json`);
  return {
    has(key) {
      return existsSync(entryFile(key));
    },
    read(key) {
      let text: string;
      try {
        text = readFileSync(entryFile(key), "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        return undefined;
      }
      return JSON.parse(text) as unknown;
    },
    record(key, detail) {
      const file = entryFile(key);
      const tmp = dir.file(`.${sha256(file).slice(0, 12)}.tmp`);
      writeFileSync(tmp, JSON.stringify({ ...detail, recordedAt: Date.now() }));
      renameSync(tmp, file); // atomic on the same filesystem
    },
  };
}

// True iff the age sweep is due (marker absent or older than the interval).
function ageSweepDue(
  dir: DataDir,
  bounds: PassSetBounds,
  now: number,
): boolean {
  try {
    return (
      now - statSync(dir.file(MARKER_FILE)).mtimeMs > bounds.pruneIntervalMs
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return true; // never swept
  }
}

// Opportunistic pruning: age-out stale entries, then cap total count. Cheap
// stat-based pass; tolerates the readdir/stat race (a concurrent writer may
// delete an entry between listing and stat).
//
// The sweep runs only when it can actually do something: either the count
// backstop is genuinely breached (read straight off the readdir, so it still
// triggers the instant it must) or the age sweep is due.
function prune(dir: DataDir, bounds: PassSetBounds): void {
  const names = readdirSync(dir.path).filter((n) => n.endsWith(".json"));
  const now = Date.now();
  if (names.length <= bounds.maxEntries && !ageSweepDue(dir, bounds, now))
    return;
  writeFileSync(dir.file(MARKER_FILE), "");
  const live: { path: string; mtimeMs: number }[] = [];
  for (const name of names) {
    const path = dir.file(name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      continue; // entry vanished underneath us — nothing to prune
    }
    if (now - mtimeMs > bounds.maxAgeMs) {
      rmSync(path, { force: true });
    } else {
      live.push({ path, mtimeMs });
    }
  }
  if (live.length > bounds.maxEntries) {
    live.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    for (const { path } of live.slice(0, live.length - bounds.trimTo)) {
      rmSync(path, { force: true });
    }
  }
}
