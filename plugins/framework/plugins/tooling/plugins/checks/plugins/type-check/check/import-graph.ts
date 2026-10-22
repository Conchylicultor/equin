// Import edges between repo files, for the lint rule groups' closures
// (`./lint-groups`), and the lint universe.
//
// The extractor below is adapted (copied & specialized to file granularity)
// from the private import-extractor in
// plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-boundaries/check/index.ts
// (extractPluginImports / extractRelativeImports / resolveImport / findSourceFiles).
// We must NOT import from that check (it's a private check file), so the logic
// is duplicated here and resolves specifiers to concrete repo-relative files.
//
// Nothing here enumerates or probes the disk: membership is the check's view
// of the repo (the run's git tree plus its overlay, `../shared/repo-view.ts`),
// handed in as a predicate. It used to build the whole repo's graph — every
// lintable file read and parsed, up to five `existsSync` per specifier — only
// to walk ~100 small closures out of it (3 CPU-s per run, measured).
//
// What remains of eslint's ignore list once git has done its part. `.gitignore`
// already withholds node_modules, dist (and dist.staging/live/old.*), .check-*,
// .claude/worktrees and web-core/dist, so a git-enumerated set never contains
// them and this predicate must not restate them. What is left are TRACKED files
// lint skips on purpose — generated sources and `prototypes/` — and those come
// from `lint/core`'s one shared list, the same one the ESLint config spreads.
// This used to be a hand-copy of that list, which is how `prototypes/**` had
// drifted out of the walk while ESLint still ignored it.

import { posix } from "path";
import {
  findImports,
  maskSource,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { isLintScopeExcluded } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export function isLintable(rel: string): boolean {
  if (!(rel.endsWith(".ts") || rel.endsWith(".tsx"))) return false;
  return !isLintScopeExcluded(rel);
}

/**
 * The lint universe of a tree's paths: the files the check lints, and the
 * files the outer read-set records a content fact for.
 *
 * ONE function for both on purpose. The read-set is recorded on the check
 * runner's thread from the run's snapshot, while the preparation thread lints
 * from its own load of the same tree (by hash); both call this over that
 * tree's paths, so the recorded set and the linted set cannot disagree.
 */
export function lintableFiles(paths: readonly string[]): string[] {
  return paths.filter(isLintable);
}

/**
 * Extract every module specifier this file depends on at compile time:
 *   - static `import ... from "<mod>"` (incl. `import type`)
 *   - `export ... from "<mod>"` re-exports (incl. `export type ... from`)
 *   - bare side-effect `import "<mod>"`
 *   - inline `import("<literal>")` type/dynamic expressions
 * Returns the raw specifier strings.
 *
 * The static forms route through `findImports` (the shared static-import
 * scanner), which masks comments/regex/strings fully and reads each specifier
 * back by offset — so an import written inside a string or template literal (a
 * test fixture, a docs snippet, a codegen template) is never mistaken for a real
 * edge. This is a compile-time import GRAPH, so we keep ALL of them: type-only
 * imports (`import type …` / `export type … from`) are real compile edges, and
 * bare side-effect imports too.
 */
export function extractImportSpecifiers(rawSrc: string): string[] {
  const results: string[] = [];

  // Static `import … from "…"` / `export … from "…"` / bare `import "…"`.
  for (const imp of findImports(rawSrc)) results.push(imp.specifier);

  // Inline `import("literal")` — type-position or dynamic. `findImports` treats
  // it as a call, not a static import, so it is out of scope there; scan for it
  // here over MASKED source and read the specifier back by offset, so an
  // `import("…")` inside a string/template literal is never mistaken for a real
  // one.
  const masked = maskSource(rawSrc);
  const re = /\bimport\s*\(\s*(["'`])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const openQuoteIdx = m.index + m[0].length - 1;
    const quote = masked[openQuoteIdx]!;
    const closeIdx = masked.indexOf(quote, openQuoteIdx + 1);
    if (closeIdx < 0) continue;
    results.push(rawSrc.slice(openQuoteIdx + 1, closeIdx));
  }

  return results;
}

const WEB_CORE_WEB = "plugins/framework/plugins/web-core/web";

/**
 * Resolve an import specifier from `fromRel` to a concrete repo-relative file
 * path, or null if it doesn't resolve to a source file in the view (bare npm
 * package, missing target, etc.).
 *
 * Only the two tsconfig aliases exist:
 *   @plugins/<rest> → plugins/<rest>
 *   @/<rest>        → plugins/framework/plugins/web-core/web/<rest>
 * Relative ./ ../ resolve against the importing file's dir.
 * Each candidate base is tried with .ts, .tsx, /index.ts, /index.tsx, against
 * `isFile` — the view's membership, never the disk.
 */
export function resolveSpecifier(
  fromRel: string,
  spec: string,
  isFile: (rel: string) => boolean,
): string | null {
  let baseRel: string | null = null;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    baseRel = posix.normalize(posix.join(posix.dirname(fromRel), spec));
    if (baseRel.endsWith("/")) baseRel = baseRel.slice(0, -1);
  } else if (spec.startsWith("@plugins/")) {
    baseRel = "plugins/" + spec.slice("@plugins/".length);
  } else if (spec === "@" || spec.startsWith("@/")) {
    const rest = spec === "@" ? "" : spec.slice("@/".length);
    baseRel = rest ? `${WEB_CORE_WEB}/${rest}` : WEB_CORE_WEB;
  } else {
    return null; // bare package or unknown alias
  }

  if (baseRel.startsWith("..")) return null; // escaped repo root

  const candidates = [
    baseRel,
    `${baseRel}.ts`,
    `${baseRel}.tsx`,
    `${baseRel}/index.ts`,
    `${baseRel}/index.tsx`,
  ];
  for (const cand of candidates) {
    if (!(cand.endsWith(".ts") || cand.endsWith(".tsx"))) continue;
    if (isFile(cand)) return cand;
  }
  return null;
}
