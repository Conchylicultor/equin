// The per-file type-aware lint RESULT store: for each (file, closure
// fingerprint), the raw error-level messages each rule group produced on it,
// under that group's fingerprint (`./lint-groups`).
//
// It replaces a PASS-only store, whose entries were recorded AFTER exemptions
// were applied — which is why an exemption manifest had to be part of every
// key. Messages are stored unfiltered; `./lint-verdict` applies the current
// exemptions when it reads them, so editing a manifest re-lints nothing.
//
// Host-global and content-addressed, like the store it replaces: a fresh
// worktree reuses what a sibling recorded for an identical closure. Each entry
// keeps the last few fingerprints per group (`keep`), so two worktrees on two
// versions of one rule do not evict each other's results on every run. The
// entry is rewritten read-modify-write and renamed into place; a race between
// two writers loses one side's additions, which is only a later miss.

import { z } from "zod";
import type { RawLintMessage } from "../core";
import { lintResultsDir } from "../data-dirs";
import { openPassSet, type PassSetBounds } from "./pass-set";

// Same bounds as the PASS store it replaces: one entry per (file, closure)
// variant, so the entry count is unchanged; an entry is ~2 KB (one group
// fingerprint per group) against 177 B, still inside one 4 KB block.
const BOUNDS: PassSetBounds = {
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxEntries: 200000,
  trimTo: 160000,
  pruneIntervalMs: 60 * 60 * 1000,
};

const messageSchema = z.object({
  ruleId: z.string().nullable(),
  fatal: z.boolean(),
  line: z.number(),
  column: z.number(),
  message: z.string(),
});

const entrySchema = z.object({
  /** Group fingerprints this file has a result for, newest first. */
  known: z.array(z.string()),
  /** Only the non-empty results, by group fingerprint. */
  messages: z.record(z.array(messageSchema)),
});

export type LintEntry = z.infer<typeof entrySchema>;

export interface LintResultStore {
  /** The entry for this (file, closure), or undefined when none was recorded. */
  read(relPath: string, closureFp: string): LintEntry | undefined;
  /**
   * Add fresh results, by group fingerprint, keeping the newest `keep`
   * fingerprints. Atomic (write-then-rename).
   */
  add(
    relPath: string,
    closureFp: string,
    fresh: ReadonlyMap<string, readonly RawLintMessage[]>,
    keep: number,
  ): void;
}

/** Merge fresh results into an entry: fresh first, then the rest, `keep` total. */
export function mergeLintEntry(
  prior: LintEntry | undefined,
  fresh: ReadonlyMap<string, readonly RawLintMessage[]>,
  keep: number,
): LintEntry {
  const known = [
    ...fresh.keys(),
    ...(prior?.known ?? []).filter((fp) => !fresh.has(fp)),
  ].slice(0, keep);
  const messages: LintEntry["messages"] = {};
  for (const fp of known) {
    const m = fresh.get(fp) ?? prior?.messages[fp] ?? [];
    if (m.length > 0) messages[fp] = [...m];
  }
  return { known, messages };
}

/** Open (and lazily create) the global lint result store. */
export function openLintResultStore(): LintResultStore {
  const set = openPassSet(lintResultsDir, BOUNDS);
  const key = (relPath: string, closureFp: string): string =>
    `${relPath}:${closureFp}`;
  const read = (relPath: string, closureFp: string): LintEntry | undefined => {
    const raw = set.read(key(relPath, closureFp));
    // Every entry is written by `add` below and renamed into place whole, so a
    // shape this schema rejects is a bug in this file — surfaced, not skipped.
    return raw === undefined ? undefined : entrySchema.parse(raw);
  };
  return {
    read,
    add(relPath, closureFp, fresh, keep) {
      const merged = mergeLintEntry(read(relPath, closureFp), fresh, keep);
      set.record(key(relPath, closureFp), { relPath, closureFp, ...merged });
    },
  };
}
