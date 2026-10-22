// The global trigger set, and the directive test — the two per-file facts the
// check reads off a path or a text.
//
// A file's lint result is stored per (file, version) (`./lint-results`), where
// the version is its git blob sha in the run's tree (`../shared/repo-view.ts`):
// what its rules read is its own text, the rules (keyed per GROUP,
// `./lint-groups`), and — for the type-aware ones only — the declarations it
// can see (its result key, `../shared/name-walk.ts`). It used to be keyed on
// the source of the file's whole forward import CLOSURE, so a body-only edit in
// a hub re-linted every transitive importer, though no rule reads another
// file's text (research/2026-10-17-global-lint-keyed-on-what-it-reads.md); and
// then on the sha256 of a re-read of every file, every run — a second hashing
// of the tree git had just hashed.

import { LINT_DATA_FILES } from "@plugins/framework/plugins/tooling/plugins/lint/core";

// The global trigger files: those whose change can alter the type-check
// VERDICT for any file. The outer read-set records each one (`./outer-read-set`),
// so a change to any of them re-runs the check. Re-running is not re-linting:
// what the inner lint cache keys on is narrower and per group (`./lint-groups`).
//
// The trigger set is a FILTER over the run's git tree, never its own walk. That
// also fixes a live bug: the walk this replaced skipped a literal `dist`
// segment but not `dist.staging.*` / `dist.live.*` / `dist.old.*` — all
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
 * The full list of global-trigger files (eslint.config.ts, plugins/**\/lint/**,
 * plugins/**\/exempt/**, tsconfig*.json, package.json, bun.lock(b), *.d.ts,
 * patches/**, *.lint.generated.ts, the lint data files) among a tree's `paths`,
 * for type-check's outer input-keyed read-set, which records a per-file
 * `(path, blobSha)` fact for each, so a compiler-version bump or a
 * rule/exemption/tsconfig edit re-runs the check. In the order of `paths`.
 */
export function findGlobalTriggerFiles(paths: readonly string[]): string[] {
  return paths.filter(isGlobalTrigger);
}

/**
 * True iff `src` can carry an eslint directive — a disable/enable comment or an
 * inline `/* eslint … *\/` config. Over-matching (the word in prose) only makes
 * the file a whole unit, which is the safe side.
 *
 * A function of the text, so the lint result store keeps it beside the results
 * of that text (`./lint-results`): only a file with no stored entry is read for
 * it.
 */
export function hasLintDirective(src: string): boolean {
  return /eslint-(?:disable|enable)|\/\*\s*eslint\s/.test(src);
}
