// What one file's CONTRACT — its emitted `.d.ts` — names: the edges of the
// declaration graph the type fingerprint walks (`./type-fingerprint.ts`).
//
// An importer's checker sees a file only through that file's declarations, and
// those declarations can name other files' types: a re-export (`export … from`),
// a type-only import, or the `import("./e").T` tsc writes for an inferred type
// that comes from elsewhere (`export type U = T`, a return type). So the files a
// file's check depends on are the closure of these edges from the file's direct
// imports — and the closure stops at a contract that names nothing that
// changed, where the SOURCE import graph would keep going through every body.
//
// An edge goes to the file that DECLARES what is named, not to the module the
// `.d.ts` happens to spell. tsc prints a type through whatever module path it
// finds accessible — `import("../index").X` for an `X` declared in
// `../types.ts` and re-exported by the barrel — and that barrel is neither
// something the importer's types depend on (the symbol is `types.ts`'s, reached
// through an alias), nor, often, in the file's source closure at all: it can
// import the very file whose contract names it. Followed as printed, the edge
// made a barrel's whole closure part of every key that saw one of its types,
// and broke the dependency order the keyed check walks in. So each specifier
// keeps the NAMES it is used for, and the resolver follows each name through
// the module's exports and aliases to its declarations. A whole-module mention
// (`export *`, `import * as`, `typeof import("x")`) stays an edge to the module.
//
// `contractSpecifiers` is PURE: `.d.ts` text in, specifiers and names out, so
// they are stored with the file's other checked results (`./keyed-check.ts`).
// Resolution is NOT stored: it is redone on every run, from the file's source
// location (`contractResolver`), so a file added that shadows a resolution, or
// a re-export that moves, can never leave a stale edge.

import { dirname, relative, resolve } from "path";
import ts from "typescript";
import { z } from "zod";
import { isRepoPath } from "./type-fingerprint";

/** A name that stands for the whole module: `export *`, `import * as`, `typeof import()`. */
export const WHOLE_MODULE = "*";

/** What one `.d.ts` names, each list sorted and de-duplicated. */
export const contractSpecifiersSchema = z.object({
  /**
   * Module specifier → the export names it is used for (`WHOLE_MODULE` for
   * the module itself): import / export declarations, `import x =
   * require()`, import types (`import("x").T` — the leftmost name of the
   * qualifier), and augmented modules.
   */
  modules: z.record(z.string(), z.array(z.string())),
  /** `/// <reference path="…" />` targets, relative to the file. */
  paths: z.array(z.string()),
});

export type ContractSpecifiers = z.infer<typeof contractSpecifiersSchema>;

/** What one emitted `.d.ts` names. */
export function contractSpecifiers(dtsText: string): ContractSpecifiers {
  const sf = ts.createSourceFile(
    "contract.d.ts",
    dtsText,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
    ts.ScriptKind.TS,
  );
  const modules = new Map<string, Set<string>>();
  const mention = (n: ts.Node | undefined, name: string): void => {
    if (!n || !ts.isStringLiteralLike(n)) return;
    let names = modules.get(n.text);
    if (names === undefined) modules.set(n.text, (names = new Set()));
    names.add(name);
  };
  const leftmost = (q: ts.EntityName): string =>
    ts.isIdentifier(q) ? q.text : leftmost(q.left);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause === undefined) mention(node.moduleSpecifier, WHOLE_MODULE);
      else {
        if (clause.name) mention(node.moduleSpecifier, "default");
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          mention(node.moduleSpecifier, WHOLE_MODULE);
        } else if (bindings) {
          for (const e of bindings.elements) {
            mention(node.moduleSpecifier, (e.propertyName ?? e.name).text);
          }
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause;
      if (clause === undefined || ts.isNamespaceExport(clause)) {
        mention(node.moduleSpecifier, WHOLE_MODULE);
      } else {
        for (const e of clause.elements) {
          mention(node.moduleSpecifier, (e.propertyName ?? e.name).text);
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      mention(node.moduleReference.expression, WHOLE_MODULE);
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) {
        mention(
          node.argument.literal,
          node.qualifier ? leftmost(node.qualifier) : WHOLE_MODULE,
        );
      }
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      // `declare module "x" { … }`. In a module file it augments `x`; in a
      // script it declares an ambient module. Either way the target is an
      // edge, and the file is global (`isGlobalFile`, read off its source).
      mention(node.name, WHOLE_MODULE);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return {
    modules: Object.fromEntries(
      [...modules.keys()].sort().map((m) => [m, [...modules.get(m)!].sort()]),
    ),
    paths: [...new Set(sf.referencedFiles.map((r) => r.fileName))].sort(),
  };
}

/** tsc's own identity for a path: lower-cased where the filesystem ignores case. */
export const canonical = (p: string): string =>
  ts.sys.useCaseSensitiveFileNames ? p : p.toLowerCase();

const rel = (root: string, abs: string): string =>
  relative(root, abs).split("\\").join("/");

/**
 * Resolves the specifiers of the contracts in one program to graph nodes, the
 * way the program resolves imports: from each file's SOURCE location, with the
 * program's options and one shared resolution cache — and each name, through
 * the module's exports and aliases, to the files declaring it.
 */
export interface ContractResolver {
  /**
   * The nodes `specs` names, for the contract of node `from`.
   *
   * A target that is a dependency is dropped: dependencies are pinned by the
   * lockfile, which is in the engine, so every key moves with them anyway. A
   * GLOBAL target is dropped too: its version is in every key already. One
   * that resolves to a repo file the program does not hold cannot come out of
   * a `.d.ts` tsc emitted for this program, so it is a bug here, and throws.
   * An unresolved specifier is an ambient module, declared by a global file.
   */
  refs(from: number, specs: ContractSpecifiers): number[];
}

export function contractResolver(
  root: string,
  program: ts.Program,
  options: ts.CompilerOptions,
  paths: readonly string[],
  global: readonly boolean[],
): ContractResolver {
  const index = new Map<string, number>();
  paths.forEach((p, i) => index.set(canonical(p), i));
  const files = program.getSourceFiles();
  const nodeOf = new Map<ts.SourceFile, number>();
  files.forEach((sf, i) => nodeOf.set(sf, i));
  const checker = program.getTypeChecker();
  const cache = ts.createModuleResolutionCache(root, canonical, options);
  const target = (
    abs: string,
    from: string,
    spec: string,
  ): number | undefined => {
    const r = rel(root, abs);
    if (!isRepoPath(r)) return undefined;
    const i = index.get(canonical(r));
    if (i === undefined) {
      throw new Error(
        `type-check: the contract of ${from} names "${spec}", which resolves to ${r} — not in the program`,
      );
    }
    return global[i] ? undefined : i;
  };
  // Per module node: export name → the repo nodes declaring it. A name the
  // module does not export (it cannot come out of tsc's emit, but an augmented
  // or merged module can spell one) is the module itself, the wide side.
  const exportsOf = new Map<number, Map<string, number[]>>();
  const declaring = (module: number, name: string): number[] => {
    let table = exportsOf.get(module);
    if (table === undefined) {
      table = new Map();
      exportsOf.set(module, table);
      const symbol = checker.getSymbolAtLocation(files[module]!);
      for (const e of symbol ? checker.getExportsOfModule(symbol) : []) {
        const resolved =
          e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e;
        const nodes = new Set<number>();
        for (const d of resolved.declarations ?? []) {
          const n = nodeOf.get(d.getSourceFile());
          if (n !== undefined && isRepoPath(paths[n]!) && !global[n]) {
            nodes.add(n);
          }
        }
        table.set(e.name, [...nodes]);
      }
    }
    return table.get(name) ?? [module];
  };
  return {
    refs(from, specs) {
      const sf = files[from]!;
      const p = paths[from]!;
      const out = new Set<number>();
      for (const [spec, names] of Object.entries(specs.modules)) {
        const resolved = ts.resolveModuleName(
          spec,
          sf.fileName,
          options,
          ts.sys,
          cache,
        ).resolvedModule;
        if (resolved === undefined) continue;
        const t = target(resolved.resolvedFileName, p, spec);
        if (t === undefined) continue;
        for (const name of names) {
          if (name === WHOLE_MODULE) out.add(t);
          else for (const d of declaring(t, name)) out.add(d);
        }
      }
      for (const ref of specs.paths) {
        const t = target(resolve(dirname(sf.fileName), ref), p, ref);
        if (t !== undefined) out.add(t);
      }
      out.delete(from);
      return [...out];
    },
  };
}
