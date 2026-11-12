// R13: a PUBLIC runtime barrel exports nothing that only tests import.
//
// R12 recognizes a test helper by how it is spelled. This rule recognizes one
// by who uses it: a name published from `<runtime>/index.ts` whose every
// importer is test code (`isTestCodePath` — `*.test.ts`, `__tests__/`,
// `testing/`) is API nothing ships with. `check/` and `lint/` importers are
// not test code here: a check may use a public API.
//
// A name nothing imports at all is out of scope — that is dead code, not a
// test leak.
//
// Pure: `findTestOnlyExports(barrels, uses)` takes what the check's per-file
// fold collected (`barrelExportNames` per public barrel, `collectBarrelUses`
// per source file, summarized and combined by `combineBarrelUses`), so the
// unit test needs no repo.

import { dirname, join } from "path";
import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
import { findImports } from "@plugins/plugin-meta/plugins/parse-utils/core";
import { parseBindingList, splitTopLevelStatements } from "./parse";
import { exportedNames } from "./test-exports";
import type { Violation } from "./unknown-dirs";

/** One importer's use of a public barrel, keyed by the barrel's `index.ts` path. */
export interface BarrelUse {
  barrel: string;
  importer: string;
  /** The barrel's own names the importer takes, or `"all"` for a namespace import from shipping code. */
  names: readonly string[] | "all";
}

const MAX_IMPORTERS_SHOWN = 3;

const FIX =
  "if the importer is this plugin's own test, import the internal file by relative path; " +
  "if another plugin's test needs it (a helper, or a real function it checks against), publish it from `<runtime>/testing/index.ts`; " +
  "move a test only when it tests nothing of its own plugin. " +
  "Then drop the name from the public barrel";

/** The names a public barrel publishes (the default export excluded). */
export function barrelExportNames(src: string): string[] {
  const names: string[] = [];
  for (const { text } of splitTopLevelStatements(src)) {
    const stmt = text.trim();
    if (!stmt.startsWith("export") || /^export\s+default\b/.test(stmt))
      continue;
    const clause = /^export\s+(?:type\s+)?\{([^}]*)\}/.exec(stmt)?.[1];
    if (clause !== undefined) {
      names.push(...exportedNames(clause));
      continue;
    }
    const declared = /^export\s+(?:type|interface)\s+([\w$]+)/.exec(stmt)?.[1];
    if (declared) names.push(declared);
  }
  return names;
}

/**
 * Every use `importer` makes of a public barrel. `isBarrel` says which
 * `index.ts` paths are public barrels; a specifier reaches one either as
 * `@plugins/<p>/<runtime>` or as a relative path landing on `<runtime>/index`.
 */
export function collectBarrelUses(
  importer: string,
  src: string,
  isBarrel: (path: string) => boolean,
): BarrelUse[] {
  const fromTest = isTestCodePath(importer.split("/"));
  const out: BarrelUse[] = [];
  for (const imp of findImports(src)) {
    if (imp.sideEffect) continue;
    const barrel = resolveBarrel(importer, imp.specifier, isBarrel);
    if (barrel === null || barrel === importer) continue;
    const clause = imp.clause.trim();
    if (/^(?:type\s+)?\*/.test(clause)) {
      // `import * as X` / `export * from`: which names it reads is not
      // written down. From shipping code, count every name as used; from a
      // test (the `vi.mock(importOriginal)` idiom), count none.
      if (!fromTest) out.push({ barrel, importer, names: "all" });
      continue;
    }
    const names = parseBindingList(clause).map((b) => b.local);
    if (names.length > 0) out.push({ barrel, importer, names });
  }
  return out;
}

function resolveBarrel(
  importer: string,
  specifier: string,
  isBarrel: (path: string) => boolean,
): string | null {
  let target: string;
  if (specifier.startsWith("@plugins/")) {
    target = `plugins/${specifier.slice("@plugins/".length)}`;
  } else if (specifier.startsWith(".")) {
    target = join(dirname(importer), specifier);
  } else {
    return null;
  }
  target = target.replace(/\/index(\.tsx?)?$/, "");
  const barrel = `${target}/index.ts`;
  return isBarrel(barrel) ? barrel : null;
}

/**
 * What a set of importers makes of each public barrel, in a form that folds:
 * the names shipping code takes (`"all"` once a namespace import takes every
 * one), and for each name no shipping code took yet, the test files that take
 * it. A name shipping code takes can never be test-only again, so its test
 * importers are dropped as soon as it is shipped — the summary stays as small
 * as the shipped names.
 */
export type BarrelUseSummary = Record<
  string,
  { shipped: string[] | "all"; tests: Record<string, string[]> }
>;

/** `uses` (in importer order) as a summary. */
export function summarizeBarrelUses(
  uses: readonly BarrelUse[],
): BarrelUseSummary {
  return combineBarrelUses(
    uses.map((use) => {
      if (!isTestCodePath(use.importer.split("/")))
        return {
          [use.barrel]: {
            shipped: use.names === "all" ? "all" : [...use.names],
            tests: {},
          },
        };
      if (use.names === "all") return {};
      // fromEntries defines own properties: a name like `__proto__` stays a key.
      const tests = Object.fromEntries(
        use.names.map((n) => [n, [use.importer]]),
      );
      return { [use.barrel]: { shipped: [], tests } };
    }),
  );
}

/**
 * Summaries merged, handed in importer order. Associative, so it folds along
 * the directory tree: what it keeps of a name is decided by the union of
 * every part, whichever way the parts were grouped.
 */
export function combineBarrelUses(
  parts: readonly BarrelUseSummary[],
): BarrelUseSummary {
  if (parts.length === 1) return parts[0]!;
  const shipped = new Map<string, Set<string> | "all">();
  const tests = new Map<string, Map<string, string[]>>();
  for (const part of parts)
    for (const [barrel, use] of Object.entries(part)) {
      const seen = shipped.get(barrel);
      if (use.shipped === "all" || seen === "all") shipped.set(barrel, "all");
      else {
        const set = seen ?? new Set<string>();
        for (const n of use.shipped) set.add(n);
        shipped.set(barrel, set);
      }
      const byName = tests.get(barrel) ?? new Map<string, string[]>();
      for (const [name, importers] of Object.entries(use.tests)) {
        const list = byName.get(name) ?? [];
        for (const f of importers) if (!list.includes(f)) list.push(f);
        byName.set(name, list);
      }
      tests.set(barrel, byName);
    }
  const out: BarrelUseSummary = {};
  for (const [barrel, names] of [...shipped].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const left: Record<string, string[]> =
      names === "all"
        ? {}
        : Object.fromEntries(
            [...tests.get(barrel)!]
              .filter(([name]) => !names.has(name))
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          );
    out[barrel] = {
      shipped: names === "all" ? "all" : [...names].sort(),
      tests: left,
    };
  }
  return out;
}

/** R13 violations: a published name with at least one importer, all of them test code. */
export function findTestOnlyExports(
  barrels: ReadonlyMap<string, readonly string[]>,
  uses: BarrelUseSummary,
): Violation[] {
  const out: Violation[] = [];
  for (const [barrel, names] of barrels) {
    if (!Object.hasOwn(uses, barrel)) continue;
    const use = uses[barrel]!;
    if (use.shipped === "all") continue;
    for (const name of new Set(names)) {
      if (!Object.hasOwn(use.tests, name)) continue;
      const importers = use.tests[name]!;
      const shown = importers
        .slice(0, MAX_IMPORTERS_SHOWN)
        .map((f) => `\`${f}\``);
      const more =
        importers.length > shown.length
          ? ` and ${importers.length - shown.length} more`
          : "";
      out.push({
        rule: "test-only-public-export",
        file: barrel,
        message: `\`${name}\` is public, but only tests import it: ${shown.join(", ")}${more}`,
        fix: FIX,
      });
    }
  }
  return out;
}
