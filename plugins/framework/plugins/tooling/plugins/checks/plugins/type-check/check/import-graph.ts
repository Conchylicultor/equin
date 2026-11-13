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
// of the repo (the run's git tree, `../shared/repo-view.ts`),
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
 * The names an edge asks of the module it imports: the ones it binds
 * (`import { a, b as c }` asks `a` and `b`), or `"all"` when it can reach any
 * of them — a namespace or default import, `export *`, a side-effect import,
 * an inline `import()`.
 */
export type ImportedNames = ReadonlySet<string> | "all";

/** One RUN-time import edge of a file: its specifier and the names it asks. */
export interface RuntimeImport {
  specifier: string;
  names: ImportedNames;
}

/**
 * Every module specifier this file depends on at RUN time — what a lint rule
 * group's members are, since a rule's output is a function of the code it
 * runs — with the names each one binds:
 *   - static `import ... from "<mod>"` and `export ... from "<mod>"`, but not
 *     the whole-statement type-only forms (`import type …` / `export type …
 *     from`): those are erased before the code runs, so no edit behind them can
 *     change a message. An inline `import { type X }` binding asks nothing of
 *     the module: the walk does not follow it (the statement still evaluates
 *     the module, but no code of it is called through this edge).
 *   - bare side-effect `import "<mod>"`
 *   - inline `import("<literal>")` — kept even in a type position, which this
 *     scan cannot tell from a dynamic import (the builder loads the lint
 *     registry that way)
 *
 * The static forms route through `findImports` (the shared static-import
 * scanner), which masks comments/regex/strings fully and reads each specifier
 * back by offset — so an import written inside a string or template literal (a
 * test fixture, a docs snippet, a codegen template) is never mistaken for a real
 * edge.
 */
export function runtimeImports(rawSrc: string): RuntimeImport[] {
  const masked = maskSource(rawSrc);
  const results: RuntimeImport[] = [];

  // Static `import … from "…"` / `export … from "…"` / bare `import "…"`.
  for (const imp of findImports(rawSrc, masked)) {
    if (imp.typeOnly) continue;
    results.push({
      specifier: imp.specifier,
      names: imp.sideEffect ? "all" : clauseNames(imp.clause).asked,
    });
  }

  // Inline `import("literal")` — type-position or dynamic. `findImports` treats
  // it as a call, not a static import, so it is out of scope there; scan for it
  // here over MASKED source and read the specifier back by offset, so an
  // `import("…")` inside a string/template literal is never mistaken for a real
  // one.
  const re = /\bimport\s*\(\s*(["'`])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const openQuoteIdx = m.index + m[0].length - 1;
    const quote = masked[openQuoteIdx]!;
    const closeIdx = masked.indexOf(quote, openQuoteIdx + 1);
    if (closeIdx < 0) continue;
    results.push({
      specifier: rawSrc.slice(openQuoteIdx + 1, closeIdx),
      names: "all",
    });
  }

  return results;
}

/**
 * A statement's binding clause, read: the names it asks of its module and,
 * for `export { a as b } from`, which name each exported one is (`b` → `a`).
 * `"all"` for a namespace (`* as ns`, `export *`) or a default import, which
 * reach every name or one no list states.
 */
function clauseNames(clause: string): {
  asked: ImportedNames;
  exported: ReadonlyMap<string, string> | "all";
} {
  const text = clause.trim();
  const open = text.indexOf("{");
  if (open < 0 || text.slice(0, open).trim() !== "") {
    return { asked: "all", exported: "all" };
  }
  const close = text.indexOf("}", open);
  const asked = new Set<string>();
  const exported = new Map<string, string>();
  for (const part of text.slice(open + 1, close).split(",")) {
    const binding = part.trim();
    if (binding === "" || /^type\s/.test(binding)) continue;
    const [from, as] = binding.split(/\s+as\s+/);
    asked.add(from!);
    exported.set(as ?? from!, from!);
  }
  return { asked, exported };
}

/** One re-export statement of a pure barrel. */
export interface BarrelReexport {
  specifier: string;
  /**
   * Exported name → the module's own name for it, or null when the name is
   * the whole module (`export * as ns`); `"all"` for `export *`.
   */
  exports: ReadonlyMap<string, string | null> | "all";
}

/**
 * A file's re-exports when it is a PURE barrel — an `index.ts(x)` whose only
 * run-time content is `export … from` statements (the barrel purity rule:
 * imports, re-exports and type aliases) — or null when it is anything else.
 * Only a pure barrel can be walked by name: what a name of it means is its
 * re-export's, and nothing else in it runs. Read conservatively: a local
 * `export { … }`, a default export or any declaration makes it null, and the
 * walk then follows every import it has.
 *
 * A run-time `import` makes it impure too: what it binds could be used by
 * anything (a file of imports alone is a side-effect module, not a barrel);
 * a barrel's type aliases import with `import type`.
 */
export function pureBarrelReexports(
  rel: string,
  rawSrc: string,
): BarrelReexport[] | null {
  if (!/(^|\/)index\.tsx?$/.test(rel)) return null;
  const masked = maskSource(rawSrc);
  const imports = findImports(rawSrc, masked);
  if (imports.some((i) => i.keyword === "import" && !i.typeOnly)) return null;
  // Blank every import/export statement, then require nothing but type
  // aliases to be left: a local `export {`, `export default`, a declaration.
  let rest = masked;
  for (const imp of imports) {
    const start = masked.lastIndexOf(imp.keyword, imp.index);
    const end = imp.index + imp.specifier.length + 1;
    rest = rest.slice(0, start) + " ".repeat(end - start) + rest.slice(end);
  }
  if (
    /\b(const|let|var|function|class|enum|namespace|declare|default)\b|\bexport\s*\{|\bexport\s*\*/.test(
      rest,
    )
  ) {
    return null;
  }
  const out: BarrelReexport[] = [];
  for (const imp of imports) {
    if (imp.keyword !== "export" || imp.typeOnly) continue;
    const ns = /^\*\s*as\s+([\w$]+)$/.exec(imp.clause.trim());
    out.push({
      specifier: imp.specifier,
      exports:
        ns !== null
          ? new Map([[ns[1]!, null]])
          : clauseNames(imp.clause).exported,
    });
  }
  return out;
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
