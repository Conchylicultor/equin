import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import {
  resolveSpecifier,
  specifierPath,
} from "@plugins/plugin-meta/plugins/plugin-records/plugins/specifier/core";

// What the geometry suite's verdict is a function of, read from the code
// itself: the files the suite and the page it builds actually load.
//
// The suite builds ONE page (Vite + Tailwind) from `web/internal/entry.tsx`,
// which reads the exhibit catalog through its generated registry — a dynamic
// `import()` of every contributor's `exhibits/index.ts` — and measures the
// measured exhibits (isolated and region ones) by rendering them. So the
// page's code is the static import closure of:
//
//   - every file of the harness plugin itself (the suite, the page entry and
//     its HTML, the Vite build script spawned by path, the oracle, this check);
//   - every contributor's exhibits barrel — what the registry loads.
//
// What is NOT followed is a dynamic `import()` anywhere else. In an exhibits
// barrel that is an `appExhibit`'s `load()`: the component behind it needs the
// live app, the measurer page never calls it (`appExhibit` cannot carry a
// geometry — a tsc error), so its code reaches no measured box. Following it
// pulled whole apps into the key: an edit to `hints/help-menu` re-ran the
// Chromium suite (~40 s, the pass's critical path) because `hints` contributes
// an app exhibit, while a primitive a measured exhibit imports from outside
// the contributor's subtree was not keyed at all.
//
// Tailwind's own `@source` scan (app.css names all of `plugins/`) is not
// followed either: a class spelled only in a file outside the closure adds a
// rule for a class no loaded module puts on a measured box. The closure's own
// sources (whose candidates do reach the page) and the stylesheet chain
// (`@import` / `@reference` / `@plugin` / `@config`, followed below) are keyed.
// Packages are keyed by `bun.lock` (Vite, Tailwind, React, Playwright).
//
// Every read goes through the run's `RepoFiles`, so in an input-keyed check
// the read-set is exactly this closure: an edit outside it replays the cached
// pass without running the check. That is why the walk is its own, not the
// plugin-records module graph's: the graph grows every module's whole reach,
// `import()`s included — an app exhibit's `load()` would put whole apps back
// in the read-set. Each specifier (script, asset or `@import`) is resolved by
// the graph's own resolver (`plugin-records/specifier`), so the walk and the
// graph cannot place one differently.

export const HARNESS_ROOT =
  "plugins/primitives/plugins/css/plugins/layout-harness";

/** A plugin's own `exhibits/` barrel — what the generated registry loads. */
const EXHIBITS_BARREL_RE =
  /^plugins\/[^/]+(?:\/plugins\/[^/]+)*\/exhibits\/index\.tsx?$/;

const SCRIPT_RE = /\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/;
const CSS_RE = /\.css$/;
const LOCKFILE = "bun.lock";
const CHECK_DIR = `${HARNESS_ROOT}/check/`;

/** One import a file makes: its specifier and whether it is a dynamic `import()`. */
export interface ScannedImport {
  path: string;
  dynamic: boolean;
}

/** The imports of a script module, type-only ones erased (Bun's transpiler — what the bundle loads). */
export type ScanImports = (rel: string, src: string) => ScannedImport[];

export function bunScanImports(rel: string, src: string): ScannedImport[] {
  const loader = rel.endsWith(".tsx") || rel.endsWith(".jsx") ? "tsx" : "ts";
  return new Bun.Transpiler({ loader })
    .scanImports(src)
    .map((i) => ({ path: i.path, dynamic: i.kind === "dynamic-import" }));
}

// `@import "x"`, `@import url("x")`, `@reference "x"`, `@plugin "x"`, `@config "x"`.
const CSS_IMPORT_RE =
  /@(?:import|reference|plugin|config)\s+(?:url\(\s*)?["']([^"']+)["']/g;

function cssImports(src: string): string[] {
  return [...src.matchAll(CSS_IMPORT_RE)].map((m) => m[1]!);
}

/**
 * The repo file `specifier` (written in `rel`) names — or null for a package,
 * keyed by the lockfile. A repo specifier naming no file of the run throws: a
 * key that skipped it could not be invalidated by the code it names.
 */
function repoTarget(
  rel: string,
  specifier: string,
  repo: Pick<RepoFiles, "has">,
): string | null {
  if (specifierPath(rel, specifier) === null) return null;
  const target = resolveSpecifier(rel, specifier, (p) => repo.has(p));
  if (target === null)
    throw new PageInputError(
      `${rel}: imports "${specifier}", which names no file of the run`,
    );
  return target;
}

export class PageInputError extends Error {}

export interface PageInputs {
  /** Every repo file the page and its suite load, sorted. */
  files: string[];
  /** Their bytes, in `files` order. */
  contents: string[];
}

/**
 * The static import closure of the harness and every exhibits barrel, with each
 * file's bytes. Throws (`PageInputError`) on an import it cannot place: a key
 * that skipped it could not be invalidated by the code it names.
 */
export async function pageInputs(
  repo: Pick<RepoFiles, "under" | "glob" | "read" | "has">,
  scan: ScanImports = bunScanImports,
): Promise<PageInputs> {
  const seeds = [
    ...repo.under(HARNESS_ROOT),
    ...repo
      .glob("plugins/**/exhibits/index.ts*")
      .filter((p) => EXHIBITS_BARREL_RE.test(p)),
    LOCKFILE,
  ];
  const content = new Map<string, string>();
  let frontier = [...new Set(seeds)];
  while (frontier.length > 0) {
    const read = await Promise.all(
      frontier.map(async (rel) => [rel, await repo.read(rel)] as const),
    );
    const next = new Set<string>();
    for (const [rel, src] of read) {
      if (src === null)
        throw new PageInputError(
          `${rel}: in the page's closure but not in the run's file set`,
        );
      content.set(rel, src);
      // The check's own code is keyed by its bytes; what it imports (spawn,
      // host admission, the deps engine) runs the suite but shapes no geometry.
      if (rel.startsWith(CHECK_DIR)) continue;
      for (const target of importsOf(rel, src, scan, repo)) {
        if (!content.has(target)) next.add(target);
      }
    }
    for (const rel of frontier) next.delete(rel);
    frontier = [...next].filter((rel) => !content.has(rel));
  }
  const files = [...content.keys()].sort();
  return { files, contents: files.map((f) => content.get(f)!) };
}

function importsOf(
  rel: string,
  src: string,
  scan: ScanImports,
  repo: Pick<RepoFiles, "has">,
): string[] {
  const specifiers = CSS_RE.test(rel)
    ? cssImports(src)
    : !SCRIPT_RE.test(rel) || rel.endsWith(".d.ts")
      ? []
      : scan(rel, src)
          // The registry's loaders are the exhibits barrels, already seeded;
          // any other `import()` is code the measurer page never runs (see
          // above).
          .filter((i) => !i.dynamic)
          .map((i) => i.path);
  const out: string[] = [];
  for (const spec of specifiers) {
    const target = repoTarget(rel, spec, repo);
    if (target !== null) out.push(target);
  }
  return out;
}
