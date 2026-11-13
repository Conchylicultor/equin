import {
  findImports,
  maskSource,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import type { FileScan } from "@plugins/plugin-meta/plugins/plugin-records/core";

// What a module's import STATEMENTS bind — the one fact the module graph's
// file facts (Bun's `scanImports`: a specifier and a kind) do not hold. A file
// record keyed by its blob like any scan; `fileSetBindings` joins it onto the
// graph's resolved edges by specifier, so a reader walking by name never
// resolves a specifier itself. Its records are keyed by this module's whole
// closure, so it holds the scan and the code it runs, and nothing else.

/**
 * The names an edge asks of the module it imports: the ones it binds
 * (`import { a, b as c }` asks `a` and `b`), or `"all"` when it can reach any
 * of them — a namespace or default import, `export *`, a side-effect import.
 */
export type BoundNames = readonly string[] | "all";

/**
 * One `export … from` of a pure re-export module: exported name → the
 * module's own name for it, or null when the name is the whole module
 * (`export * as ns`); `"all"` for `export *`.
 */
export interface ReexportFacts {
  spec: string;
  exports: readonly (readonly [exported: string, own: string | null])[] | "all";
}

export interface BindingFacts {
  /**
   * Per specifier, the names its run-time static statements bind (the union
   * over every statement naming it; `"all"` once one asks every name). A
   * whole-statement `import type` / `export type … from` asks nothing and is
   * absent; an inline `type` binding asks nothing of its statement.
   */
  names: Readonly<Record<string, BoundNames>>;
  /**
   * The module's re-exports when it is a PURE re-export module — its only
   * run-time content is `export … from` statements (and type aliases): no
   * run-time `import`, no local `export { … }`, default export or
   * declaration — else null. Only such a module can be walked by name: what a
   * name of it means is its re-export's, and nothing else in it runs.
   */
  reexports: readonly ReexportFacts[] | null;
}

/**
 * A statement's binding clause, read: the names it asks of its module and,
 * for `export { a as b } from`, which name each exported one is (`b` → `a`).
 * `"all"` for a namespace (`* as ns`, `export *`) or a default import, which
 * reach every name or one no list states.
 */
function clauseNames(clause: string): {
  asked: BoundNames;
  exported: [string, string][] | "all";
} {
  const text = clause.trim();
  const open = text.indexOf("{");
  if (open < 0 || text.slice(0, open).trim() !== "") {
    return { asked: "all", exported: "all" };
  }
  const close = text.indexOf("}", open);
  const asked = new Set<string>();
  const exported: [string, string][] = [];
  for (const part of text.slice(open + 1, close).split(",")) {
    const binding = part.trim();
    if (binding === "" || /^type\s/.test(binding)) continue;
    const [from, as] = binding.split(/\s+as\s+/);
    asked.add(from!);
    exported.push([as ?? from!, from!]);
  }
  return { asked: [...asked], exported };
}

export function bindingFacts(src: string): BindingFacts {
  const masked = maskSource(src);
  const imports = findImports(src, masked);
  const names: Record<string, BoundNames> = {};
  for (const imp of imports) {
    if (imp.typeOnly) continue;
    const asked = imp.sideEffect ? "all" : clauseNames(imp.clause).asked;
    const before = names[imp.specifier];
    names[imp.specifier] =
      before === "all" || asked === "all"
        ? "all"
        : [...new Set([...(before ?? []), ...asked])];
  }
  return { names, reexports: pureReexports(imports, masked) };
}

function pureReexports(
  imports: ReturnType<typeof findImports>,
  masked: string,
): ReexportFacts[] | null {
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
  const out: ReexportFacts[] = [];
  for (const imp of imports) {
    if (imp.keyword !== "export" || imp.typeOnly) continue;
    const ns = /^\*\s*as\s+([\w$]+)$/.exec(imp.clause.trim());
    out.push({
      spec: imp.specifier,
      exports:
        ns !== null ? [[ns[1]!, null]] : clauseNames(imp.clause).exported,
    });
  }
  return out;
}

/** {@link bindingFacts} as a file scan. */
export const BINDINGS_SCAN: FileScan<BindingFacts> = {
  url: import.meta.url,
  scan: (src) => bindingFacts(src),
};
