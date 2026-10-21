// The per-file lint RESULT store: for each (file, content hash), the raw
// error-level messages each part of its lint produced, under that part's key.
//
// Keyed on the file's OWN text, not on its import closure, because that is all
// most rules read (research/2026-10-17-global-lint-keyed-on-what-it-reads.md):
//
//   - a SYNTACTIC group's result is a function of the text and the group's
//     rules — its key is the group fingerprint (`./lint-groups`);
//   - the TYPED part also reads the checker's types, which are a function of
//     the declarations the file can see — its key folds in the file's result
//     key (`typedResultKey`, `../shared/keys`; `../shared/name-walk.ts`);
//   - a directive file's WHOLE result is keyed the same way, on every rule.
//
// The closure key this replaced re-linted every transitive importer of a file
// whose BODY changed — a median of 470 files per main commit, p90 6,218 —
// though no rule reads another file's text and tsc already knew the API had not
// moved.
//
// Messages are stored unfiltered; `./lint-verdict` applies the current
// exemptions when it reads them, so editing a manifest re-lints nothing.
//
// Host-global and content-addressed: a fresh worktree reuses what a sibling
// recorded for an identical file. Each entry keeps the last few keys per part
// (`keep`), most recently USED first — a key a run reused moves up beside the
// fresh ones — so two worktrees on two versions of one rule — or of one hub's
// API — do not evict each other's results on every run. The entry is rewritten
// read-modify-write and renamed into place; a race between two writers loses
// one side's additions, which is only a later miss.

import { z } from "zod";
import type { RawLintMessage } from "../core";
import { lintResultsV2Dir } from "../data-dirs";
import { openPassSet, type PassSetBounds } from "../shared/pass-set";

// One entry per (file, content) variant — at most as many as the closure-keyed
// store it replaces, which had one per (file, closure) and so at least one per
// text. An entry is ~2 KB (one key per group), inside one 4 KB block.
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
  /** Syntactic group fingerprints this text has a result for, newest first. */
  syntactic: z.array(z.string()),
  /**
   * Typed result keys (the typed group's, or a directive file's whole one),
   * newest first. Apart from `syntactic` because a deferred typed part ships
   * these few to the worker, which must not receive ~100 group keys per file.
   */
  typed: z.array(z.string()),
  /** Only the non-empty results, by key. */
  messages: z.record(z.array(messageSchema)),
});

export type LintEntry = z.infer<typeof entrySchema>;

/**
 * Fresh results for one file, by key; the stored keys this run REUSED (they
 * move up, so a result in use is never the one evicted); and how many keys of
 * each part to keep.
 */
export interface LintEntryUpdate {
  syntactic: ReadonlyMap<string, readonly RawLintMessage[]>;
  typed: ReadonlyMap<string, readonly RawLintMessage[]>;
  reusedSyntactic: ReadonlySet<string>;
  reusedTyped: ReadonlySet<string>;
  keepSyntactic: number;
  keepTyped: number;
}

export interface LintResultStore {
  /** The entry for this (file, content), or undefined when none was recorded. */
  read(relPath: string, contentHash: string): LintEntry | undefined;
  /**
   * Add fresh results and move reused keys up, keeping the most recently used
   * keys per part. Atomic (write-then-rename); no write when the merge changes
   * nothing.
   */
  add(relPath: string, contentHash: string, update: LintEntryUpdate): void;
}

/**
 * Fresh keys first, then the prior ones this run reused, then the rest — each
 * group in its prior order, so a run that only reuses keys already in front
 * changes nothing — `keep` in all.
 */
function mergeKeys(
  prior: readonly string[],
  fresh: ReadonlyMap<string, unknown>,
  reused: ReadonlySet<string>,
  keep: number,
): string[] {
  const old = prior.filter((k) => !fresh.has(k));
  return [
    ...fresh.keys(),
    ...old.filter((k) => reused.has(k)),
    ...old.filter((k) => !reused.has(k)),
  ].slice(0, keep);
}

/** Merge fresh results into an entry: per part, fresh first, then the rest. */
export function mergeLintEntry(
  prior: LintEntry | undefined,
  update: LintEntryUpdate,
): LintEntry {
  const syntactic = mergeKeys(
    prior?.syntactic ?? [],
    update.syntactic,
    update.reusedSyntactic,
    update.keepSyntactic,
  );
  const typed = mergeKeys(
    prior?.typed ?? [],
    update.typed,
    update.reusedTyped,
    update.keepTyped,
  );
  const messages: LintEntry["messages"] = {};
  const keep = (
    key: string,
    fresh: readonly RawLintMessage[] | undefined,
  ): void => {
    const m = fresh ?? prior?.messages[key] ?? [];
    if (m.length > 0) messages[key] = [...m];
  };
  for (const k of syntactic) keep(k, update.syntactic.get(k));
  for (const k of typed) keep(k, update.typed.get(k));
  return { syntactic, typed, messages };
}

/** Whether two entries hold the same keys in the same order (and so the same messages). */
export function sameEntry(a: LintEntry, b: LintEntry): boolean {
  const same = (x: readonly string[], y: readonly string[]): boolean =>
    x.length === y.length && x.every((k, i) => k === y[i]);
  return (
    same(a.syntactic, b.syntactic) &&
    same(a.typed, b.typed) &&
    JSON.stringify(a.messages) === JSON.stringify(b.messages)
  );
}

/** Open (and lazily create) the global lint result store. */
export function openLintResultStore(): LintResultStore {
  const set = openPassSet(lintResultsV2Dir, BOUNDS);
  const key = (relPath: string, contentHash: string): string =>
    `${relPath}:${contentHash}`;
  const read = (
    relPath: string,
    contentHash: string,
  ): LintEntry | undefined => {
    const raw = set.read(key(relPath, contentHash));
    // Every entry is written by `add` below and renamed into place whole, so a
    // shape this schema rejects is a bug in this file — surfaced, not skipped.
    return raw === undefined ? undefined : entrySchema.parse(raw);
  };
  return {
    read,
    add(relPath, contentHash, update) {
      const prior = read(relPath, contentHash);
      const merged = mergeLintEntry(prior, update);
      if (prior !== undefined && sameEntry(prior, merged)) return;
      set.record(key(relPath, contentHash), {
        relPath,
        contentHash,
        ...merged,
      });
    },
  };
}
