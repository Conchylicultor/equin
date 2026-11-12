import ts from "typescript";
import { resolve as resolvePath } from "path";
import type { SourceAnalysis } from "@plugins/framework/plugins/tooling/plugins/checks/plugins/source-analysis/core";
import type { ExportRef } from "./probe-types";
import {
  bindingValue,
  constantHole,
  type Constant,
  type Hole,
  type ScannedSite,
  type SqlSite,
  type Value,
} from "./sites";

// The cross-file half of hole resolution: a `Deferred` value a file's fold
// recorded (`sites.ts`) is followed into the files it names — an import
// through barrels' re-exports, an exported `const` of a schema file the probe
// evaluates. Only the holes that have one get here (a few dozen sites, ~10
// files), so this reads what those holes name, never the tree. Modules are
// resolved and parsed by the run's source analysis (the repo project's own
// module resolution, over the run's file set).

type Resolved =
  Constant | { readonly kind: "export"; readonly ref: Omit<ExportRef, "id"> };

const UNKNOWN: Resolved = { kind: "unknown" };

/** Re-export hops followed before giving up (`export *` chains, as before). */
const MAX_DEPTH = 20;

export function createHoleResolver(opts: {
  analysis: SourceAnalysis;
  /** The checkout's root: an `export` hole names its schema file absolutely, as the probe takes it. */
  root: string;
  /** Repo-relative schema-glob files: the exports the probe can evaluate. */
  schemaFiles: ReadonlySet<string>;
}): { resolveSite(site: ScannedSite): Promise<SqlSite> } {
  const { analysis, root, schemaFiles } = opts;

  /** `v`, read in file `rel`, followed into the files it names. */
  const resolve = async (
    rel: string,
    v: Value,
    seen: ReadonlySet<string>,
  ): Promise<Resolved> => {
    switch (v.kind) {
      case "string":
      case "raw":
      case "ident":
      case "unknown":
        return v;
      case "import": {
        const m = analysis.resolveModule(rel, v.spec);
        if (m.kind !== "repo") return UNKNOWN;
        return exportValue(m.rel, v.name, v.path, 0, seen);
      }
      case "own-export":
        return schemaFiles.has(rel)
          ? {
              kind: "export",
              ref: {
                file: resolvePath(root, rel),
                exportName: v.name,
                path: [...v.path],
              },
            }
          : UNKNOWN;
      case "concat": {
        let out = "";
        for (const p of v.parts) {
          if (typeof p === "string") {
            out += p;
            continue;
          }
          const r = await resolve(rel, p, seen);
          if (r.kind !== "string") return UNKNOWN;
          out += r.value;
        }
        return { kind: "string", value: out };
      }
      case "wrap": {
        const r = await resolve(rel, v.inner, seen);
        return r.kind === "string" ? { kind: v.as, value: r.value } : UNKNOWN;
      }
      case "either": {
        const r = await resolve(rel, v.first, seen);
        return r.kind !== "unknown" ? r : resolve(rel, v.orElse, seen);
      }
    }
  };

  /** Export `name` (then `path` into it) of `rel`, followed through re-exports. */
  const exportValue = async (
    rel: string,
    name: string,
    path: readonly string[],
    depth: number,
    seen: ReadonlySet<string>,
  ): Promise<Resolved> => {
    // A cycle of consts naming each other has no value (and never ends).
    const key = `${rel}\0${name}\0${path.join(".")}`;
    if (depth > MAX_DEPTH || seen.has(key)) return UNKNOWN;
    const inner = new Set(seen).add(key);
    const f = await analysis.file(rel);
    if (f === null) return UNKNOWN;
    const sf = f.sf;
    for (const stmt of sf.statements) {
      if (
        ts.isVariableStatement(stmt) &&
        stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        for (const d of stmt.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.name.text === name)
            return resolve(rel, bindingValue(sf, d.name, path), inner);
      }
      if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly) {
        const from =
          stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
            ? analysis.resolveModule(rel, stmt.moduleSpecifier.text)
            : null;
        const target = from?.kind === "repo" ? from.rel : null;
        const clause = stmt.exportClause;
        if (!clause) {
          // export * from "…"
          if (target === null) continue;
          const v = await exportValue(target, name, path, depth + 1, inner);
          if (v.kind !== "unknown") return v;
          continue;
        }
        if (!ts.isNamedExports(clause)) continue;
        for (const el of clause.elements) {
          if (el.name.text !== name) continue;
          const local = (el.propertyName ?? el.name).text;
          if (stmt.moduleSpecifier !== undefined)
            return target === null
              ? UNKNOWN
              : exportValue(target, local, path, depth + 1, inner);
          const id = ts.factory.createIdentifier(local);
          // A local re-export (`export { x }`): resolve `x` at file scope.
          (id as { parent?: ts.Node }).parent = sf;
          return resolve(rel, bindingValue(sf, id, path), inner);
        }
      }
    }
    return UNKNOWN;
  };

  return {
    async resolveSite(site) {
      const holes: Hole[] = [];
      for (const h of site.holes) {
        if (h.kind !== "deferred") {
          holes.push(h);
          continue;
        }
        const v = await resolve(site.file, h.value, new Set());
        holes.push(
          v.kind === "export"
            ? { kind: "export", ref: v.ref }
            : constantHole(v, site.tagged, h.expr),
        );
      }
      return { ...site, holes };
    },
  };
}
