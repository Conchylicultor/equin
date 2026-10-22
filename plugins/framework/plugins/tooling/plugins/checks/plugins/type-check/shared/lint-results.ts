// The per-file lint RESULT store: for each (file, version), the raw
// error-level messages each part of its lint produced, under that part's key.
// A file's version is its git blob sha (`./repo-view.ts`), read out of
// the run's tree — so looking an entry up reads no file.
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
// Messages are stored unfiltered; `../check/lint-verdict` applies the current
// exemptions when it reads them, so editing a manifest re-lints nothing.
//
// Whether the text carries an eslint directive (`hasLintDirective`) is a
// function of the text, so it is stored in the entry too: a run reads the text
// of a file with no entry only — and such a file is linted anyway.
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
import { lintResultsV3Dir } from "../data-dirs";
import { openPassSet, type PassSetBounds } from "./pass-set";

/** The groups holding at least one enabled type-aware rule (`typeAwareLintGroups`). */
export interface TypeAwareGroups {
  base: boolean;
  contributions: ReadonlySet<string>;
}

// One entry per (file, content) variant — at most as many as the closure-keyed
// store it replaces, which had one per (file, closure) and so at least one per
// text. An entry is ~2 KB (one key per group), inside one 4 KB block.
const BOUNDS: PassSetBounds = {
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxEntries: 200000,
  trimTo: 160000,
  pruneIntervalMs: 60 * 60 * 1000,
};

/** One raw lint message as stored (here, and in the run base `./run-base.ts`). */
export const messageSchema = z.object({
  ruleId: z.string().nullable(),
  fatal: z.boolean(),
  line: z.number(),
  column: z.number(),
  message: z.string(),
});

const entrySchema = z.object({
  /**
   * Whether the text can carry an eslint directive (`hasLintDirective`): such
   * a file is linted and stored as one unit (`LINT_GROUP_ALL`).
   */
  directive: z.boolean(),
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
  /** The text's directive flag: what the plan ran it as. */
  directive: boolean;
  syntactic: ReadonlyMap<string, readonly RawLintMessage[]>;
  typed: ReadonlyMap<string, readonly RawLintMessage[]>;
  reusedSyntactic: ReadonlySet<string>;
  reusedTyped: ReadonlySet<string>;
  keepSyntactic: number;
  keepTyped: number;
}

export interface LintResultStore {
  /** The entry for this (file, version), or undefined when none was recorded. */
  read(relPath: string, version: string): LintEntry | undefined;
  /**
   * Write an entry as merged by the caller (`mergeLintEntry` over the entry it
   * read). Atomic (write-then-rename); a race with another writer loses one
   * side's additions, which is only a later miss.
   */
  put(relPath: string, version: string, entry: LintEntry): void;
  /**
   * Which rule groups hold a type-aware rule, recorded under `key` — a hash of
   * what that is a function of (every group's fingerprint, `./lint-groups`) —
   * or undefined when it was never recorded.
   */
  readTypeAware(key: string): TypeAwareGroups | undefined;
  writeTypeAware(key: string, groups: TypeAwareGroups): void;
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
  if (prior !== undefined && prior.directive !== update.directive) {
    // One text, one flag: two answers mean the key does not name one text.
    throw new Error(
      `type-check: a lint entry says directive=${prior.directive}, its update ${update.directive} — the store's key does not name one text`,
    );
  }
  return { directive: update.directive, syntactic, typed, messages };
}

/** Whether two entries hold the same keys in the same order (and so the same messages). */
export function sameEntry(a: LintEntry, b: LintEntry): boolean {
  const same = (x: readonly string[], y: readonly string[]): boolean =>
    x.length === y.length && x.every((k, i) => k === y[i]);
  return (
    a.directive === b.directive &&
    same(a.syntactic, b.syntactic) &&
    same(a.typed, b.typed) &&
    JSON.stringify(a.messages) === JSON.stringify(b.messages)
  );
}

const typeAwareSchema = z.object({
  base: z.boolean(),
  contributions: z.array(z.string()),
});

/** Open (and lazily create) the global lint result store. */
export function openLintResultStore(): LintResultStore {
  const set = openPassSet(lintResultsV3Dir, BOUNDS);
  // A path never starts with NUL, so the two kinds of key cannot meet.
  const key = (relPath: string, version: string): string =>
    `${relPath}:${version}`;
  const typeAwareKey = (k: string): string => `\0type-aware\0${k}`;
  const read = (relPath: string, version: string): LintEntry | undefined => {
    const raw = set.read(key(relPath, version));
    // Every entry is written by `add` below and renamed into place whole, so a
    // shape this schema rejects is a bug in this file — surfaced, not skipped.
    return raw === undefined ? undefined : entrySchema.parse(raw);
  };
  return {
    read,
    put(relPath, version, entry) {
      set.record(key(relPath, version), { relPath, version, ...entry });
    },
    readTypeAware(k) {
      const raw = set.read(typeAwareKey(k));
      if (raw === undefined) return undefined;
      const parsed = typeAwareSchema.parse(raw);
      return {
        base: parsed.base,
        contributions: new Set(parsed.contributions),
      };
    },
    writeTypeAware(k, groups) {
      set.record(typeAwareKey(k), {
        base: groups.base,
        contributions: [...groups.contributions].sort(),
      });
    },
  };
}
