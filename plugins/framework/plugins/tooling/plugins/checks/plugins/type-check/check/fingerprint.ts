// Dependency-closure fingerprints for the eslint check.
//
// Each file's type-aware lint result depends on the file PLUS everything it
// transitively imports (type info flows through forward import edges) PLUS the
// rules that ran on it. The closure fingerprint is the first half, one
// content-addressed key per file; the rules are keyed per GROUP beside it
// (`./lint-groups`), so a rule edit no longer changes every file's key. A result
// stored under both is reusable across runs and worktrees.

import { createHash } from "crypto";
import { join } from "path";
import { listRepoFiles } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { LINT_DATA_FILES } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { ImportGraphs } from "./import-graph";
import { safeRead } from "./import-graph";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface FingerprintResult {
  perFile: Map<string, string>; // relpath -> closureFingerprint
  /** The run's memoized per-file content hash, for the group fingerprints. */
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
// perturbed the global fingerprint and invalidated the entire closure cache for
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
 * questions of the repo's files: the lint closure fingerprint's trigger set,
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
 * Compute the closure fingerprint for each candidate file:
 *
 *   closure(f) = { f } ∪ transitive forward-closure of f over graphs.forward
 *   fp(f) = sha256( sorted( `${c}\0${ch(c)}` for c in closure(f) ).join("\n") )
 *
 * Nothing global: which rules ran is keyed per group beside it
 * (`./lint-groups`). The closure DFS is memoized and cycle-safe (a visited
 * set), and per-file content hashes ch(rel) are memoized — both shared across
 * all candidates, and `ch` is handed back for the group fingerprints. Reading a
 * file to hash it also notes whether it can carry an eslint directive.
 */
export function computeClosureFingerprints(
  listing: TreeListing,
  graphs: ImportGraphs,
  candidates: string[],
): FingerprintResult {
  const { root } = listing;

  // Memoized per-file content hash: ch(rel) = sha256(content ?? "").
  const contentHash = new Map<string, string>();
  const directives = new Set<string>();
  const ch = (rel: string): string => {
    let h = contentHash.get(rel);
    if (h === undefined) {
      const src = safeRead(join(root, rel)) ?? "";
      if (hasLintDirective(src)) directives.add(rel);
      h = sha256(src);
      contentHash.set(rel, h);
    }
    return h;
  };

  // Memoized transitive forward closure (the unordered SET of reachable files,
  // including the file itself). Cycle-safe via the visited set.
  const closureCache = new Map<string, Set<string>>();
  const closureOf = (start: string): Set<string> => {
    const cached = closureCache.get(start);
    if (cached) return cached;
    const visited = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const deps = graphs.forward.get(cur);
      if (!deps) continue;
      for (const dep of deps) {
        if (!visited.has(dep)) stack.push(dep);
      }
    }
    closureCache.set(start, visited);
    return visited;
  };

  const perFile = new Map<string, string>();
  for (const f of candidates) {
    const closure = closureOf(f);
    const body = [...closure]
      .sort()
      .map((c) => `${c}\0${ch(c)}`)
      .join("\n");
    perFile.set(f, sha256(body));
  }

  return {
    perFile,
    contentHash: ch,
    // Only candidates: a non-candidate hashed as someone's import is not linted.
    directives: new Set(candidates.filter((f) => directives.has(f))),
  };
}
