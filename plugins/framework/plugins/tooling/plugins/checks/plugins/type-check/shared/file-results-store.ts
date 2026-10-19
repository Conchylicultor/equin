// The checked-results store: per unit key (`./keyed-check.ts`), what checking
// that unit gave — each file's diagnostics, signature and contract specifiers.
//
// Host-global and content-addressed: a key is a hash of everything a file's
// check reads, so it names the same answer in every worktree, and a fresh
// worktree on a main tree reuses what main's build checked. That is what
// replaced the `.tsbuildinfo` warm-base pool, which had to GUESS which base
// fit a tree best.

import { z } from "zod";
import { fileResultsDir } from "../data-dirs";
import { fileResultSchema, type FileResultsLookup } from "./keyed-check";
import { openPassSet, type PassSetBounds } from "./pass-set";

// About one entry per repo source file per API-relevant version, a few hundred
// bytes each: a cold run writes ~12k. Bounded like the lint result store,
// which holds one per (file, text) — at least as many.
const BOUNDS: PassSetBounds = {
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxEntries: 300000,
  trimTo: 240000,
  pruneIntervalMs: 60 * 60 * 1000,
};

const entrySchema = z.object({ files: z.record(z.string(), fileResultSchema) });

/** Open (and lazily create) the host-global checked-results store. */
export function openFileResultsStore(): FileResultsLookup {
  const set = openPassSet(fileResultsDir, BOUNDS);
  return {
    read(key) {
      const raw = set.read(key);
      // Written by `record` below and renamed into place whole: a shape this
      // schema rejects is a bug in this file, surfaced.
      return raw === undefined ? undefined : entrySchema.parse(raw).files;
    },
    record(key, files) {
      set.record(key, { files });
    },
  };
}
