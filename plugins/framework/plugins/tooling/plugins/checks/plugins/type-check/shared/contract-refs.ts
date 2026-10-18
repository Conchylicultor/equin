// What one file's CONTRACT — its emitted `.d.ts` — names: the edges of the
// declaration graph the type fingerprint walks (`./type-fingerprint.ts`).
//
// An importer's checker sees a file only through that file's declarations, and
// those declarations can name other files' types: a re-export (`export … from`),
// a type-only import, or the `import("./e").T` tsc writes for an inferred type
// that comes from elsewhere (`export type U = T`, a return type). So the files a
// typed lint result depends on are the closure of these edges from the file's
// direct imports — and the closure stops at a contract that names nothing that
// changed, where the SOURCE import graph would keep going through every body.
//
// PURE: `.d.ts` text in, specifiers out. tsc's signature for a file is the hash
// of exactly this text (`computeSignatureWithDiagnostics`), so the specifiers
// are a function of (file, signature) and can be stored under that key
// (`./contract-refs-store.ts`). Resolution is NOT part of that: a specifier is
// resolved on every run, from the file's source location (`contractEdges`), so
// a file added that shadows a resolution can never leave a stale edge.

import { dirname, relative, resolve } from "path";
import ts from "typescript";
import { z } from "zod";
import {
  isRepoPath,
  needsContract,
  type BuildInfoGraph,
  type Contract,
} from "./type-fingerprint";

/** The specifiers one `.d.ts` names, each list sorted and de-duplicated. */
export const contractSpecifiersSchema = z.object({
  /**
   * Module specifiers: import / export declarations, `import x = require()`,
   * and import types (`import("x").T`).
   */
  modules: z.array(z.string()),
  /** `/// <reference path="…" />` targets, relative to the file. */
  paths: z.array(z.string()),
  /**
   * Whether the contract augments another module (`declare module "x"` in a
   * module file). An augmentation changes what EVERY importer of `x` sees,
   * though none of them names this file — so its signature counts as global
   * scope, like a `declare global` file's.
   */
  augments: z.boolean(),
});

export type ContractSpecifiers = z.infer<typeof contractSpecifiersSchema>;

const sorted = (s: Set<string>): string[] => [...s].sort();

/** The specifiers one emitted `.d.ts` names. */
export function contractSpecifiers(dtsText: string): ContractSpecifiers {
  const sf = ts.createSourceFile(
    "contract.d.ts",
    dtsText,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
    ts.ScriptKind.TS,
  );
  const modules = new Set<string>();
  let augments = false;
  const literal = (n: ts.Node | undefined): void => {
    if (n && ts.isStringLiteralLike(n)) modules.add(n.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      literal(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      literal(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) literal(node.argument.literal);
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      // `declare module "x" { … }`. In a module file it augments `x`; in a
      // script it declares an ambient module, and a script affects the global
      // scope anyway. Either way the target is an edge too.
      augments = true;
      modules.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return {
    modules: sorted(modules),
    paths: sorted(new Set(sf.referencedFiles.map((r) => r.fileName))),
    augments,
  };
}

/** Where recorded specifiers live: per (file, signature), host-wide in the worker. */
export interface ContractRefsLookup {
  read(relPath: string, signature: string): ContractSpecifiers | undefined;
  record(relPath: string, signature: string, refs: ContractSpecifiers): void;
}

/** tsc's own identity for a path: lower-cased where the filesystem ignores case. */
export const canonical = (p: string): string =>
  ts.sys.useCaseSensitiveFileNames ? p : p.toLowerCase();

const rel = (root: string, abs: string): string =>
  relative(root, abs).split("\\").join("/");

/**
 * Every repo source file's contract edges, as nodes of the buildinfo graph:
 * the specifiers its `.d.ts` names — from this run's emit (`emitted`, by
 * canonical repo path), else `store`, else by emitting that one file's
 * declaration now (recorded, so it is paid once per file API version) —
 * resolved from the file's source location the way the program resolves its
 * imports.
 *
 * A specifier that resolves to a dependency is dropped: dependencies are pinned
 * by the lockfile, which is in the lint engine, so every key moves with them
 * anyway. One that resolves to a repo file the program does not hold cannot
 * come out of a `.d.ts` tsc emitted for this program, so it is a bug here, and
 * throws. An unresolved specifier is an ambient module, declared by a
 * global-scope file every fingerprint already folds in.
 */
export function contractEdges(
  root: string,
  program: ts.Program,
  options: ts.CompilerOptions,
  graph: Pick<BuildInfoGraph, "paths" | "shapes">,
  emitted: ReadonlyMap<string, ContractSpecifiers>,
  store: ContractRefsLookup,
): { contracts: Map<number, Contract>; summary: string } {
  const start = performance.now();
  const { paths, shapes } = graph;
  const index = new Map<string, number>();
  paths.forEach((p, i) => index.set(canonical(p), i));
  const sources = new Map<string, ts.SourceFile>();
  for (const sf of program.getSourceFiles()) {
    sources.set(canonical(rel(root, sf.fileName)), sf);
  }
  const cache = ts.createModuleResolutionCache(root, canonical, options);
  const counts = { files: 0, stored: 0, emitted: 0, alone: 0 };
  const contracts = new Map<number, Contract>();
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
    return i;
  };
  paths.forEach((p, i) => {
    if (!needsContract(p)) return;
    counts.files++;
    const key = canonical(p);
    const shape = shapes[i]!;
    const sf = sources.get(key);
    if (sf === undefined) {
      throw new Error(
        `type-check: ${p} is in the buildinfo but not in the program it was written for`,
      );
    }
    let specs = emitted.get(key);
    if (specs !== undefined) {
      counts.emitted++;
      if (store.read(key, shape) === undefined) store.record(key, shape, specs);
    } else {
      specs = store.read(key, shape);
      if (specs !== undefined) {
        counts.stored++;
      } else {
        let text: string | undefined;
        program.emit(
          sf,
          (fileName, data) => {
            if (/\.d\.[mc]?ts$/.test(fileName)) text = data;
          },
          undefined,
          /*emitOnlyDtsFiles*/ true,
        );
        if (text === undefined) {
          throw new Error(
            `type-check: emitting ${p}'s declaration produced no .d.ts`,
          );
        }
        specs = contractSpecifiers(text);
        store.record(key, shape, specs);
        counts.alone++;
      }
    }
    const refs = new Set<number>();
    for (const spec of specs.modules) {
      const resolved = ts.resolveModuleName(
        spec,
        sf.fileName,
        options,
        ts.sys,
        cache,
      ).resolvedModule;
      if (resolved === undefined) continue;
      const t = target(resolved.resolvedFileName, p, spec);
      if (t !== undefined) refs.add(t);
    }
    for (const ref of specs.paths) {
      const t = target(resolve(dirname(sf.fileName), ref), p, ref);
      if (t !== undefined) refs.add(t);
    }
    contracts.set(i, { refs: [...refs], augments: specs.augments });
  });
  const ms = Math.round(performance.now() - start);
  return {
    contracts,
    summary:
      `contracts of ${counts.files} files: ${counts.stored} stored, ` +
      `${counts.emitted} from this run's emit, ${counts.alone} emitted alone, ${ms}ms`,
  };
}
