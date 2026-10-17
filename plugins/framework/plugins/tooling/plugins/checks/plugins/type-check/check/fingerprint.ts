// The tree listing, the global trigger set, and each lintable file's content
// hash — the half of a lint result's key that is the file itself.
//
// A file's lint result is stored per (file, content hash) (`./lint-results`):
// what its rules read is its own text, the rules (keyed per GROUP,
// `./lint-groups`), and — for the type-aware ones only — the declarations it
// can see (its type fingerprint, `../shared/type-fingerprint`). It used to be
// keyed on the source of the file's whole forward import CLOSURE, so a body-only
// edit in a hub re-linted every transitive importer, though no rule reads
// another file's text (research/2026-10-17-global-lint-keyed-on-what-it-reads.md).

import { createHash } from "crypto";
import { join } from "path";
import { listRepoFiles } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { LINT_DATA_FILES } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { safeRead } from "./import-graph";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface ContentHashes {
  /**
   * The run's memoized per-file content hash: the lint result store's key, and
   * the group fingerprints' input.
   */
  contentHash: (rel: string) => string;
  /** Candidates whose text can carry an eslint directive (`hasLintDirective`). */
  directives: Set<string>;
}

// The global trigger files: those whose change can alter the type-check
// VERDICT for any file. The outer read-set records each one (`./outer-read-set`),
// so a change to any of them re-runs the check. Re-running is not re-linting:
// what the inner lint cache keys on is narrower and per group (`./lint-groups`).
//
// The trigger set is a FILTER over the run's one git-derived listing, never its
// own walk. That also fixes a live bug: the walk this replaced skipped a literal
// `dist` segment but not `dist.staging.*` / `dist.live.*` / `dist.old.*` — all
// gitignored, all capable of holding a `package.json` or a `.d.ts`. One of those
// perturbed the global fingerprint and invalidated the entire lint cache for
// a change that never lands on main. Git's own ignore rules cover every
// spelling, so there is nothing left here to keep in sync.

function isGlobalTrigger(rel: string): boolean {
  if (rel === "eslint.config.ts") return true;
  // Any plugins/**/lint/ directory (a path segment `lint/` under plugins/),
  // and any plugins/**/exempt/ one: an exemption manifest decides which lint
  // messages are dropped from files that do not import it, so an edit to one
  // must re-lint every file (the exempt primitive's own generated registry
  // sits under a segment of that name too).
  if (rel.startsWith("plugins/")) {
    const segs = rel.split("/");
    if (segs.includes("lint") || segs.includes("exempt")) return true;
  }
  if (rel.endsWith("lint.generated.ts")) return true;
  // A file a class rule reads (app.css's declared @utility set): a change can
  // flip the verdict on any file that uses one of its classes.
  if (LINT_DATA_FILES.includes(rel)) return true;
  // Any tsconfig*.json — root or any plugin.
  const base = rel.split("/").pop()!;
  if (base.startsWith("tsconfig") && base.endsWith(".json")) return true;
  if (rel === "package.json") return true;
  if (rel === "bun.lock" || rel === "bun.lockb") return true;
  if (rel.endsWith(".d.ts")) return true;
  // A dependency patch (`patchedDependencies`) changes the patched package's
  // behaviour without changing its resolved version.
  if (rel.startsWith("patches/")) return true;
  return false;
}

/**
 * One reading of "what files does this tree contain", taken once and passed to
 * everything that asks.
 *
 * ONE traversal, several predicates. A single check pass asks four different
 * questions of the repo's files: the lint key's global trigger set,
 * the outer read-set's copy of the same set, the program key's tsc-relevant
 * subset, and the program key's name census. Enumerated separately those were
 * four full traversals costing seconds — and, worse, four copies of the
 * enumeration RULES, so "skip nested worktrees" had four places to drift from.
 *
 * A VALUE rather than a memo behind the function, because a snapshot of a
 * changing tree needs a visible lifetime. As a module-level cache its
 * staleness window was "the rest of the process", invisible at every call site;
 * as a value, whoever wants a fresh reading takes one.
 */
export interface TreeListing {
  root: string;
  /** Every repo-relevant file under `root`, repo-relative, deduped and sorted. */
  files: string[];
}

/**
 * Take one git-backed reading of `root`'s files.
 *
 * The source is GIT, not a filesystem walk, because this check is `inputKeyed`:
 * its verdict must be a function of the tree its cache key hashes, and that key
 * is git-derived (`computeTreeHash` = a scratch index + `git add -A`). A walk
 * saw gitignored files the key does not cover — a stray `.ts` under `.cache/`
 * reached the coverage gate and failed a build over content no key represents.
 * `listRepoFiles` returns exactly the membership the key folds in, already
 * deduped and sorted. See
 * research/2026-09-09-tooling-check-file-enumeration-from-git.md.
 */
export async function readTreeListing(root: string): Promise<TreeListing> {
  return { root, files: await listRepoFiles(root) };
}

/** The files of a listing whose repo-relative path `matches`. */
export function findFiles(
  listing: TreeListing,
  matches: (rel: string) => boolean,
): string[] {
  return listing.files.filter(matches);
}

/**
 * The full list of global-trigger files (eslint.config.ts, plugins/**\/lint/**,
 * plugins/**\/exempt/**, tsconfig*.json, package.json, bun.lock(b), *.d.ts,
 * patches/**, *.lint.generated.ts, the lint data files), for type-check's outer
 * input-keyed read-set, which records a per-file `(path, blobSha)` fact for
 * each, so a compiler-version bump or a rule/exemption/tsconfig edit re-runs the
 * check. Deduped + sorted for determinism.
 */
export function findGlobalTriggerFiles(listing: TreeListing): string[] {
  return findFiles(listing, isGlobalTrigger);
}

/**
 * True iff `src` can carry an eslint directive — a disable/enable comment or an
 * inline `/* eslint … *\/` config. Over-matching (the word in prose) only makes
 * the file a whole unit, which is the safe side.
 */
export function hasLintDirective(src: string): boolean {
  return /eslint-(?:disable|enable)|\/\*\s*eslint\s/.test(src);
}

/**
 * Hash each candidate file's content, noting which can carry an eslint
 * directive (such a file is linted and stored as one unit, `LINT_GROUP_ALL`).
 *
 *   ch(rel) = sha256(content ?? "")
 *
 * Memoized and handed back: the group fingerprints (`./lint-groups`) hash the
 * engine's and each contribution's files through the same memo, so a file is
 * read once per run whoever asks.
 */
export function computeContentHashes(
  listing: TreeListing,
  candidates: string[],
): ContentHashes {
  const { root } = listing;
  const memo = new Map<string, string>();
  const directives = new Set<string>();
  const ch = (rel: string): string => {
    let h = memo.get(rel);
    if (h === undefined) {
      const src = safeRead(join(root, rel)) ?? "";
      if (hasLintDirective(src)) directives.add(rel);
      h = sha256(src);
      memo.set(rel, h);
    }
    return h;
  };
  for (const f of candidates) ch(f);
  return {
    contentHash: ch,
    // Only candidates: a non-candidate hashed as an engine file is not linted.
    // A snapshot NOW, while only candidates have been hashed.
    directives: new Set(candidates.filter((f) => directives.has(f))),
  };
}
