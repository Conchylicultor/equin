// A TypeScript program's file graph: what each file references, its version,
// and whether it is global — the source graph the type fingerprint's first hop
// follows (`./type-fingerprint.ts`).
//
// It used to be read off the `.tsbuildinfo`'s `referencedMap`, which TS 6's
// incremental builder writes. The keyed engine (`./keyed-check.ts`) builds a
// plain program with no builder, so this is a port of the builder's own
// `getReferencedFiles` (TS 6.0.3, `BuilderState`) onto the program, and the
// test holds it equal to the builder's map on fixtures that exercise every
// edge kind (`./program-graph.test.ts`):
//
//   - each import literal → the files declaring the module symbol it names
//     (a resolved module, or every declaration of an ambient one);
//   - each `/// <reference path>` → that file;
//   - each resolved `/// <reference types>` (and `types` entry) → its file;
//   - each module augmentation → the files declaring the augmented module;
//   - every ambient module declared in more than one file → those files.
//
// `sf.imports`, `sf.moduleAugmentations` and
// `program.forEachResolvedTypeReferenceDirective` are TypeScript internals (the
// builder reads them the same way). Each is read through one accessor that
// throws when it is missing, so a compiler that moves them fails here, loudly,
// rather than yielding an empty graph.

import { createHash } from "crypto";
import { dirname, relative, resolve } from "path";
import ts from "typescript";
import type { ProgramGraph } from "./type-fingerprint";

/** The internals of a source file the builder reads too. */
interface SourceFileInternals {
  imports: readonly ts.StringLiteralLike[];
  moduleAugmentations: readonly (ts.StringLiteral | ts.Identifier)[];
}

function internals(sf: ts.SourceFile): SourceFileInternals {
  const raw = sf as unknown as Partial<SourceFileInternals>;
  if (!Array.isArray(raw.imports) || !Array.isArray(raw.moduleAugmentations)) {
    throw new Error(
      `type-check: ${sf.fileName} has no imports / moduleAugmentations — this TypeScript (${ts.version}) moved the internals the program graph reads`,
    );
  }
  return raw as SourceFileInternals;
}

/** A file's version: the hash of its text. */
export function versionOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Whether a file is GLOBAL for the type fingerprint: tsc's own
 * `isFileAffectingGlobalScope` (a `declare global`, or a script — not a
 * module, not JSON, not only ambient module declarations), or a module
 * augmentation (`declare module "x"` in a module): every importer of `x` sees
 * it without naming this file.
 */
export function isGlobalFile(sf: ts.SourceFile): boolean {
  const { moduleAugmentations } = internals(sf);
  if (moduleAugmentations.length > 0) return true;
  if (ts.isExternalModule(sf) || sf.fileName.endsWith(".json")) return false;
  return !sf.statements.every(
    (s) =>
      ts.isModuleDeclaration(s) &&
      (ts.isStringLiteral(s.name) ||
        (s.flags & ts.NodeFlags.GlobalAugmentation) !== 0),
  );
}

type TypeRefCallback = (resolution: {
  resolvedTypeReferenceDirective?: { resolvedFileName?: string };
}) => void;

function forEachResolvedTypeReference(
  program: ts.Program,
  sf: ts.SourceFile,
  callback: TypeRefCallback,
): void {
  const fn = (
    program as unknown as {
      forEachResolvedTypeReferenceDirective?: (
        cb: TypeRefCallback,
        file: ts.SourceFile,
      ) => void;
    }
  ).forEachResolvedTypeReferenceDirective;
  if (typeof fn !== "function") {
    throw new Error(
      `type-check: this TypeScript (${ts.version}) has no program.forEachResolvedTypeReferenceDirective, which the program graph reads`,
    );
  }
  fn.call(program, callback, sf);
}

const rel = (root: string, abs: string): string =>
  relative(root, abs).split("\\").join("/");

/** The program's file graph, in `program.getSourceFiles()` order. */
export function programGraph(root: string, program: ts.Program): ProgramGraph {
  const files = program.getSourceFiles();
  const index = new Map<ts.SourceFile, number>();
  files.forEach((sf, i) => index.set(sf, i));
  const checker = program.getTypeChecker();
  const byPath = new Map<string, number>();
  // tsc's own identity for a path: lower-cased where the filesystem ignores case.
  const key = (abs: string): string =>
    ts.sys.useCaseSensitiveFileNames
      ? resolve(abs)
      : resolve(abs).toLowerCase();
  files.forEach((sf, i) => byPath.set(key(sf.fileName), i));
  const nodeOf = (sf: ts.SourceFile | undefined): number | undefined =>
    sf === undefined ? undefined : index.get(sf);

  // Every ambient module declared in more than one file: each of its files is
  // referenced by EVERY file (the builder's last loop).
  const sharedAmbient: number[] = [];
  for (const m of checker.getAmbientModules()) {
    if ((m.declarations?.length ?? 0) <= 1) continue;
    for (const d of m.declarations!) {
      const n = nodeOf(d.getSourceFile());
      if (n !== undefined) sharedAmbient.push(n);
    }
  }

  const succ: number[][] = files.map((sf, self) => {
    const out = new Set<number>();
    const addDeclaringFiles = (symbol: ts.Symbol | undefined): void => {
      for (const d of symbol?.declarations ?? []) {
        const n = nodeOf(d.getSourceFile());
        if (n !== undefined) out.add(n);
      }
    };
    const { imports, moduleAugmentations } = internals(sf);
    for (const lit of imports)
      addDeclaringFiles(checker.getSymbolAtLocation(lit));
    for (const ref of sf.referencedFiles) {
      const n = byPath.get(key(resolve(dirname(sf.fileName), ref.fileName)));
      if (n !== undefined) out.add(n);
    }
    forEachResolvedTypeReference(program, sf, (resolution) => {
      const file = resolution.resolvedTypeReferenceDirective?.resolvedFileName;
      if (file === undefined) return;
      const n = byPath.get(key(file));
      if (n !== undefined) out.add(n);
    });
    for (const name of moduleAugmentations) {
      if (!ts.isStringLiteral(name)) continue;
      const symbol = checker.getSymbolAtLocation(name);
      for (const d of symbol?.declarations ?? []) {
        const n = nodeOf(d.getSourceFile());
        if (n !== undefined && n !== self) out.add(n);
      }
    }
    for (const n of sharedAmbient) if (n !== self) out.add(n);
    return [...out].sort((a, b) => a - b);
  });

  return {
    paths: files.map((sf) => rel(root, sf.fileName)),
    versions: files.map((sf) => versionOf(sf.text)),
    global: files.map(isGlobalFile),
    succ,
  };
}
