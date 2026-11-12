import { dirname, posix } from "path";
import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  packageNameFor,
  PLUGIN_PACKAGE_PREFIX,
  RUNTIME_FOLDERS,
  TESTING_FOLDER,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  findImports,
  maskSource,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { splitTopLevelStatements } from "./parse";
import { summarizeExports, type FileExports } from "./reexport-provenance";
import { findTestSupportInBarrel } from "./test-exports";
import {
  barrelExportNames,
  collectBarrelUses,
  combineBarrelUses,
  summarizeBarrelUses,
  type BarrelUseSummary,
} from "./test-only-exports";
import type { Violation } from "./unknown-dirs";

// plugin-boundaries' per-file rules as a fold kept along the directory tree
// (`checks/core`'s `defineFoldCheck` over plugin-records' `foldFilesCached`):
// each file judged on its own bytes — the import grammar (R4–R10), the edges
// it adds to the plugin graph (R6), the barrel names it takes (R13), its own
// barrel rules when it is one (R3 purity, R12) and its package name when it is
// a package.json (R1) — and what the cross-file rules read of it (the re-exports
// a provenance chase follows, the names a public barrel publishes). A pass
// after an edit judges the edited files only. Its records are keyed by this
// module's whole closure, so it holds the per-file rules and nothing else.

/** What every file's part reads besides the file: every plugin under `plugins/` (sorted), and whether it is a composition root. */
export type PluginBoundariesContext = {
  plugins: readonly (readonly [path: string, compositionRoot: boolean])[];
};

/** A per-file violation; `exemptable` ones are dropped for a file the plugin-boundaries exemptions cover. */
export interface FileViolation extends Violation {
  exemptable?: true;
}

/** One file's, or one directory's, part of the verdict. */
export interface PluginBoundariesPart {
  violations: FileViolation[];
  /**
   * The cycle graph's cross-plugin edges, by source: `<from>\0<runtime>` → the
   * plugins its files of that runtime import, sorted, unique (a source spelled
   * once, not once per edge — the answer is rewritten whole on every edit).
   */
  edges: Record<string, string[]>;
  /** Each public barrel's published names (R13). */
  barrels: Record<string, string[]>;
  /** What the files make of each public barrel (R13). */
  uses: BarrelUseSummary;
  /** The re-exports of every plugin file that has any (R3's provenance chase). */
  exports: Record<string, FileExports>;
}

/** The barrel folders a cross-plugin specifier may end at (boundaries' `runtimeNames`, from its source). */
const runtimeNames: ReadonlySet<string> = new Set(RUNTIME_FOLDERS);

/** The runtime barrels R3 requires, checks for purity and R12 (central/machine are optional). */
const R3_RUNTIMES: ReadonlySet<string> = new Set([
  "web",
  "server",
  "machine",
  "central",
  "core",
]);
/** Runtimes whose `<runtime>/index.ts` is a public barrel (R13). */
const PUBLIC_RUNTIMES: ReadonlySet<string> = new Set(
  RUNTIME_FOLDERS.filter((r) => r !== "shared"),
);
/** Runtimes whose `<runtime>/testing/index.ts` is a testing barrel (R3). */
const TESTING_RUNTIMES: ReadonlySet<string> = new Set(
  RUNTIME_FOLDERS.filter((r) => r !== "shared" && r !== "e2e"),
);

interface Plugins {
  set: ReadonlySet<string>;
  compositionRoots: ReadonlySet<string>;
}

// One parsed plugin set per context: the fold hands every scan the same object.
const pluginsOf = new WeakMap<PluginBoundariesContext, Plugins>();
function plugins(context: PluginBoundariesContext): Plugins {
  let p = pluginsOf.get(context);
  if (!p) {
    p = {
      set: new Set(context.plugins.map(([path]) => path)),
      compositionRoots: new Set(
        context.plugins.filter(([, root]) => root).map(([path]) => path),
      ),
    };
    pluginsOf.set(context, p);
  }
  return p;
}

/** The plugin path owning `rel` (the longest plugin-dir prefix), or null outside every plugin. */
export function pluginForPath(
  rel: string,
  pluginSet: ReadonlySet<string>,
): string | null {
  if (!rel.startsWith("plugins/")) return null;
  const parts = rel.slice("plugins/".length).split("/");
  let best: string | null = null;
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join("/");
    if (pluginSet.has(candidate)) best = candidate;
  }
  return best;
}

/** Whether `path` names a public runtime barrel (`plugins/<plugin>/<runtime>/index.ts`) — by its spelling. */
function isPublicBarrelPath(
  path: string,
  pluginSet: ReadonlySet<string>,
): boolean {
  const owner = pluginForPath(path, pluginSet);
  if (owner === null) return false;
  const [runtime, file, ...rest] = path
    .slice(`plugins/${owner}/`.length)
    .split("/");
  return (
    rest.length === 0 && file === "index.ts" && PUBLIC_RUNTIMES.has(runtime!)
  );
}

function emptyPart(): PluginBoundariesPart {
  return { violations: [], edges: {}, barrels: {}, uses: {}, exports: {} };
}

/** One file's part. */
export function judgeFile(
  src: string,
  rel: string,
  context: PluginBoundariesContext,
): PluginBoundariesPart {
  const { set: pluginSet, compositionRoots } = plugins(context);
  const part = emptyPart();
  const owner = pluginForPath(rel, pluginSet);
  const inOwner = owner === null ? null : rel.slice(`plugins/${owner}/`.length);
  const structural = owner !== null && !compositionRoots.has(owner);

  if (rel.endsWith("/package.json")) {
    // R1: a plugin's own package.json (composition roots are exempt).
    if (structural && inOwner === "package.json")
      part.violations.push(...checkPackageNaming(owner, rel, src));
    return part;
  }

  // R3 (purity, R12) for a barrel of a structural plugin; R13's published names
  // for any plugin's public barrel.
  if (owner !== null && inOwner !== null) {
    const [runtime, second, third, ...more] = inOwner.split("/");
    if (second === "index.ts" && third === undefined) {
      if (structural && R3_RUNTIMES.has(runtime!)) {
        part.violations.push(...checkBarrelPurity(rel, src));
        // R12: test helpers go in `<runtime>/testing/`, never the public barrel.
        part.violations.push(...findTestSupportInBarrel(rel, src));
      }
      if (PUBLIC_RUNTIMES.has(runtime!))
        part.barrels[rel] = barrelExportNames(src);
    }
    if (
      structural &&
      second === TESTING_FOLDER &&
      third === "index.ts" &&
      more.length === 0 &&
      TESTING_RUNTIMES.has(runtime!)
    )
      part.violations.push(...checkBarrelPurity(rel, src));
    const exports = summarizeExports(src);
    if (exports !== null) part.exports[rel] = exports;
  }

  // R13: which public-barrel names this file takes.
  part.uses = summarizeBarrelUses(
    collectBarrelUses(rel, src, (path) => isPublicBarrelPath(path, pluginSet)),
  );

  judgeImports(src, rel, owner, pluginSet, part);
  return part;
}

/** R4–R10 and R6's edges: the imports of one source file. */
function judgeImports(
  src: string,
  rel: string,
  sourcePlugin: string | null,
  pluginSet: ReadonlySet<string>,
  part: PluginBoundariesPart,
): void {
  const { violations } = part;
  const imports = findImports(src);

  // R7: forbid direct workspace-name imports (`@equin/plugin-*`).
  // Cross-plugin imports must go through `@plugins/...` so R4/R5/R6 can
  // see them; workspace-name imports resolve via node_modules symlinks
  // and silently bypass the boundary system.
  for (const { specifier } of imports) {
    if (!specifier.startsWith(PLUGIN_PACKAGE_PREFIX)) continue;
    violations.push({
      rule: "workspace-import",
      file: rel,
      message: `direct workspace import \`${specifier}\` bypasses the boundary system`,
      fix: `replace with the path-alias form \`@plugins/<path-to-plugin>/<runtime>\` (R4/R5/R6 only see those)`,
    });
  }

  // R8: forbid relative imports that escape the source plugin into a
  // different plugin's tree. Same motivation as R7 — relative paths
  // resolve outside the `@plugins/...` alias system, so R4/R5/R6 can't
  // see them, and a sub-plugin reaching `../../../../web/components/foo`
  // into its parent's internals silently bypasses every barrier.
  if (sourcePlugin) {
    for (const { specifier } of imports) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      const resolved = posix.normalize(posix.join(dirname(rel), specifier));
      const targetPlugin = pluginForPath(resolved, pluginSet);
      if (!targetPlugin || targetPlugin === sourcePlugin) continue;
      violations.push({
        rule: "relative-cross-plugin",
        file: rel,
        message: `relative import \`${specifier}\` reaches into a different plugin (\`${targetPlugin}\`)`,
        fix: `cross-plugin imports must go through the barrel — replace with \`@plugins/${targetPlugin}/<runtime>\` and re-export the symbol from that plugin's \`index.ts\` if it isn't already public`,
      });
    }
  }

  // R9: forbid inline import-type expressions targeting plugin barrels. They
  // bypass the static import scanner and make cross-plugin deps invisible to
  // the boundary system. Use a top-level `import type { X } from "…"` instead.
  // Framework files (plugin registries) are exempt — their dynamic imports
  // are the resilient-loading mechanism, not accidental boundary bypasses.
  if (!rel.endsWith(".generated.ts")) {
    for (const inlinePath of extractInlineImports(src)) {
      const resolved = resolveImport(inlinePath, pluginSet);
      if (!resolved) continue;
      if (sourcePlugin && sourcePlugin === resolved.pluginPath) continue;
      violations.push({
        rule: "inline-import",
        file: rel,
        message: `inline \`import("${inlinePath}")\` type expression bypasses the boundary system`,
        fix: `replace with a top-level import type statement: \`import type { … } from "${inlinePath}"\``,
        exemptable: true,
      });
    }
  }

  const targets = new Set<string>();
  let edgeSource: string | null = null;
  if (sourcePlugin) {
    const segment = rel.slice(`plugins/${sourcePlugin}/`.length).split("/")[0];
    if (segment && runtimeNames.has(segment))
      edgeSource = `${sourcePlugin}\0${segment}`;
  }
  for (const imp of extractPluginImports(imports)) {
    const resolved = resolveImport(imp.path, pluginSet);
    if (!resolved) continue;

    // Intra-plugin imports (source is the same plugin) are unrestricted
    // here, EXCEPT: shared/ must use relative paths, not the @plugins
    // alias. Which own folder a runtime may reach is `boundary-rules`'
    // job — it applies the runtime table inside a plugin too.
    if (sourcePlugin === resolved.pluginPath) {
      if (resolved.suffixHead === "shared") {
        violations.push({
          rule: "shared-use-relative",
          file: rel,
          message: `use a relative import instead of \`${imp.path}\``,
          fix: `shared/ is plugin-private — import via relative path (e.g. \`../shared${resolved.tail ? "/" + resolved.tail : ""}\`) instead of the @plugins alias`,
        });
      }
      continue;
    }

    // R10: cross-plugin shared/ imports are forbidden — shared/ is plugin-private.
    if (resolved.suffixHead === "shared") {
      violations.push({
        rule: "cross-plugin-internal",
        file: rel,
        message: `cross-plugin import from \`${imp.path}\` — shared/ is plugin-private`,
        fix: `if \`${resolved.pluginPath}\` needs a public API, create a \`core/\` barrel`,
        exemptable: true,
      });
    }

    // Cross-plugin asset imports (e.g. a global `.css` stylesheet) are
    // side-effect references to a non-JS file. They cannot be routed through
    // a JS barrel — a stylesheet is not an exported symbol — so the
    // barrel-grammar rule (R4) doesn't apply. The DAG edge is still tracked
    // below (R6), so a cyclic asset dependency is still caught.
    const isAssetImport =
      imp.kind === "side-effect" && isAssetSpecifier(imp.path);

    // R4: grammar — the import must end at `<runtime>` or at
    // `<runtime>/testing` (the runtime's test-helper barrel), nothing
    // deeper. WHO may import a testing barrel is boundary-rules' job.
    if (
      !isAssetImport &&
      (!runtimeNames.has(resolved.suffixHead) ||
        (resolved.tail !== "" && resolved.tail !== TESTING_FOLDER))
    ) {
      violations.push({
        rule: "grammar",
        file: rel,
        message: `cross-plugin import into non-barrel path: \`${imp.path}\``,
        fix: `import from the plugin's barrel (\`@plugins/${resolved.pluginPath}/${resolved.suffixHead || "<runtime>"}\`, or its \`/${TESTING_FOLDER}\` barrel from test code) and re-export the needed symbol from the target plugin's \`index.ts\` if it isn't already public`,
        exemptable: true,
      });
    }

    // R5: only framework files may pull a plugin's default export across boundaries.
    if (imp.kind === "default") {
      violations.push({
        rule: "default-import",
        file: rel,
        message: `default import from \`${imp.path}\` is not allowed outside the plugin registries`,
        fix: `other plugins may only use named imports. The default export (PluginDefinition) is consumed exclusively by the generated registry files (e.g. \`web.generated.ts\`, \`server.generated.ts\`).`,
        exemptable: true,
      });
    }

    // R6: track DAG edge (deduped), tagged with source file's runtime.
    // Files in tooling folders (lint/, check/) have no runtime — those
    // imports are skipped entirely rather than collapsed to "shared".
    if (edgeSource !== null) targets.add(resolved.pluginPath);
  }
  if (edgeSource !== null && targets.size > 0)
    part.edges = { [edgeSource]: [...targets].sort() };
}

// ============================================================================
// R1: package.json naming
// ============================================================================

// The name is DERIVED (`packageNameFor`) and written by the repo-tree codegen
// (`syncPluginPackageNames`, run by `./equin build` and
// `./equin regen-generated`). R1 is its in-sync guard, the same role
// `plugins-registry-in-sync` plays for the registries.

export const REGEN_HINT =
  "run `./equin build` (or `./equin regen-generated`), which writes the derived name";

function checkPackageNaming(
  pluginPath: string,
  rel: string,
  raw: string,
): Violation[] {
  const expected = packageNameFor(pluginPath);
  let data: { name?: unknown };
  try {
    data = JSON.parse(raw) as { name?: unknown };
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return [
      { rule: "package", file: rel, message: "package.json is not valid JSON" },
    ];
  }
  if (data.name === expected) return [];
  return [
    {
      rule: "package",
      file: rel,
      message: `package name is \`${String(data.name)}\`; expected \`${expected}\``,
      fix: REGEN_HINT,
    },
  ];
}

// ============================================================================
// R3: barrel purity
// ============================================================================

/**
 * An `index.ts` may only contain:
 *   - import statements
 *   - named re-exports: `export { ... }`, `export { ... } from "..."`, `export type { ... }`
 *   - type/interface aliases: `type X = ...`, `interface X { ... }` (bare or exported)
 *   - exactly one `export default <expression>`
 *
 * `export * from "..."` / `export * as X from "..."` are disallowed because
 * docgen can't follow them to enumerate the public surface — every public
 * name must be written in the barrel. Wrap with a named re-export instead:
 * `import * as X from "./shared"; export { X };`.
 *
 * Any runtime declaration at the top level (`const`, `let`, `var`, `function`, `class`,
 * top-level `await`, control flow) is a violation — it should live in a sibling file
 * (conventionally `shared/`).
 */
function checkBarrelPurity(relPath: string, raw: string): Violation[] {
  const violations: Violation[] = [];
  for (const { text, line } of splitTopLevelStatements(raw)) {
    const trimmed = text.trim();
    // Cross-plugin re-export detection (direct, indirect, and
    // import-then-reexport) lives in the name-level provenance resolver
    // (`collectForeignReexports`), run over the folded re-exports.
    if (!trimmed || isAllowedBarrelStatement(trimmed)) continue;
    const head = trimmed.split(/\s+/).slice(0, 3).join(" ");
    const shown = `${head}${trimmed.length > head.length ? "…" : ""}`;
    if (isWildcardReexport(trimmed)) {
      violations.push({
        rule: "barrel-purity",
        file: `${relPath}:${line}`,
        message: `wildcard re-export in barrel: \`${shown}\``,
        fix: 'docgen can\'t follow `export *` to enumerate the public surface — every exported name must be written in the barrel. Replace with named re-exports (`export { A, B, type C } from "./shared/foo"`) or namespace: `import * as Foo from "./shared/foo"; export { Foo };`.',
      });
      continue;
    }
    violations.push({
      rule: "barrel-purity",
      file: `${relPath}:${line}`,
      message: `disallowed top-level statement in barrel: \`${shown}\``,
      fix: "move this code into a sibling file (conventionally `shared/`). Barrels may only contain imports, re-exports, type aliases, and a single `export default`.",
    });
  }
  return violations;
}

function isWildcardReexport(s: string): boolean {
  if (!s.startsWith("export ")) return false;
  const rest = s.slice("export ".length).trimStart();
  if (rest.startsWith("*")) return true;
  if (rest.startsWith("type ")) {
    const afterType = rest.slice("type ".length).trimStart();
    if (afterType.startsWith("*")) return true;
  }
  return false;
}

function isAllowedBarrelStatement(s: string): boolean {
  if (s.startsWith("import ") || s.startsWith("import{")) return true;
  if (s.startsWith("export default")) return true;
  if (s.startsWith("type ") || s.startsWith("interface ")) return true;
  if (s.startsWith("export type ") || s.startsWith("export interface "))
    return true;
  if (s.startsWith("export ")) {
    // Allowed: `export { ... }` (possibly with `from "..."`).
    // Disallowed: `export * from "..."` (docgen can't enumerate wildcard
    //             re-exports), `export const/let/var/function/class/async`.
    const rest = s.slice("export ".length).trimStart();
    return rest.startsWith("{");
  }
  return false;
}

// ============================================================================
// Import extraction (R4, R5, R6, R9)
// ============================================================================

type ImportKind = "default" | "named" | "namespace" | "side-effect";

interface Imp {
  path: string;
  kind: ImportKind;
}

function extractInlineImports(rawSrc: string): string[] {
  const masked = maskSource(rawSrc);
  const results: string[] = [];
  const re = /\bimport\s*\(\s*(["'`])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const openQuoteIdx = m.index + m[0].length - 1;
    const quote = masked[openQuoteIdx]!;
    const closeIdx = masked.indexOf(quote, openQuoteIdx + 1);
    if (closeIdx < 0) continue;
    const spec = rawSrc.slice(openQuoteIdx + 1, closeIdx);
    if (spec.startsWith("@plugins/")) results.push(spec);
  }
  return results;
}

function extractPluginImports(imports: ReturnType<typeof findImports>): Imp[] {
  const results: Imp[] = [];
  for (const imp of imports) {
    if (!imp.specifier.startsWith("@plugins/")) continue;
    if (imp.sideEffect) {
      results.push({ path: imp.specifier, kind: "side-effect" });
      continue;
    }
    const body = imp.clause.trim();
    if (!looksLikeImportOrReexport(imp.keyword, body)) continue;
    results.push({
      path: imp.specifier,
      kind: classifyKind(imp.keyword, body),
    });
  }
  return results;
}

const ASSET_EXTENSIONS = [
  ".css",
  ".scss",
  ".sass",
  ".png",
  ".jpg",
  ".jpeg",
  ".svg",
  ".woff",
  ".woff2",
];
function isAssetSpecifier(specifier: string): boolean {
  return ASSET_EXTENSIONS.some((ext) => specifier.endsWith(ext));
}

function looksLikeImportOrReexport(keyword: string, body: string): boolean {
  if (keyword === "import") {
    if (body === "") return true;
    if (/^\*\s+as\s+\w+$/.test(body)) return true;
    if (/^type\s+/.test(body)) {
      const rest = body.replace(/^type\s+/, "");
      return (
        /^\w+$/.test(rest) ||
        /^\{[^}]*\}$/.test(rest) ||
        /^\*\s+as\s+\w+$/.test(rest)
      );
    }
    if (/^\w+$/.test(body)) return true;
    if (/^\{[\s\S]*\}$/.test(body)) return true;
    if (/^\w+\s*,\s*\{[\s\S]*\}$/.test(body)) return true;
    return false;
  }
  if (keyword === "export") {
    if (/^\{[\s\S]*\}$/.test(body)) return true;
    if (/^\*(\s+as\s+\w+)?$/.test(body)) return true;
    if (/^type\s+/.test(body)) {
      const rest = body.replace(/^type\s+/, "");
      return /^\{[\s\S]*\}$/.test(rest) || /^\*(\s+as\s+\w+)?$/.test(rest);
    }
    return false;
  }
  return false;
}

function classifyKind(keyword: string, body: string): ImportKind {
  if (keyword === "export") return "named";
  if (body === "") return "side-effect";
  if (/^\*\s+as\s+\w+$/.test(body)) return "namespace";
  if (/^type\s+\*\s+as\s+\w+$/.test(body)) return "namespace";
  const stripped = body.replace(/^type\s+/, "").trim();
  if (/^\w+(\s*,\s*\{[\s\S]*\})?$/.test(stripped)) return "default";
  return "named";
}

interface ResolvedImport {
  pluginPath: string;
  suffixHead: string;
  tail: string;
}

function resolveImport(
  importPath: string,
  pluginSet: ReadonlySet<string>,
): ResolvedImport | null {
  if (!importPath.startsWith("@plugins/")) return null;
  const rest = importPath.slice("@plugins/".length);
  const parts = rest.split("/");
  let best = "";
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join("/");
    if (pluginSet.has(candidate)) best = candidate;
  }
  if (!best) return null;
  const remainder = rest.slice(best.length).replace(/^\//, "");
  if (!remainder) return { pluginPath: best, suffixHead: "", tail: "" };
  const remParts = remainder.split("/");
  return {
    pluginPath: best,
    suffixHead: remParts[0]!,
    tail: remParts.slice(1).join("/"),
  };
}

// ============================================================================
// The fold
// ============================================================================

function sortedRecord<T>(entries: Iterable<[string, T]>): Record<string, T> {
  return Object.fromEntries(
    [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

export const pluginBoundariesFold: FileFold<
  PluginBoundariesContext,
  PluginBoundariesPart
> = {
  url: import.meta.url,
  scan: judgeFile,
  combine(parts) {
    if (parts.length === 1) return parts[0]!;
    const edges = new Map<string, Set<string>>();
    for (const p of parts)
      for (const [source, targets] of Object.entries(p.edges)) {
        const set = edges.get(source) ?? new Set<string>();
        for (const t of targets) set.add(t);
        edges.set(source, set);
      }
    return {
      violations: parts.flatMap((p) => p.violations),
      edges: sortedRecord(
        [...edges].map(([source, set]) => [source, [...set].sort()]),
      ),
      barrels: sortedRecord(parts.flatMap((p) => Object.entries(p.barrels))),
      uses: combineBarrelUses(parts.map((p) => p.uses)),
      exports: sortedRecord(parts.flatMap((p) => Object.entries(p.exports))),
    };
  },
};
