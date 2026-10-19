// The compiler options the worker builds the program with, on top of the
// tsconfig's own: what lets every checked file be emitted as a `.d.ts` — whose
// hash is its signature, what its importers' keys see — and that signature a
// pure function of the code. One function so the worker, the oracle and the
// tests that hold its purity cannot drift apart.

import type ts from "typescript";

/**
 * `base` (the parsed tsconfig's options) with declaration emit to `outDir`
 * (named, never written: the worker's writer keeps the `.d.ts` text in
 * memory).
 */
export function signatureEmitOptions(
  base: ts.CompilerOptions,
  root: string,
): ts.CompilerOptions {
  return {
    ...base,
    // Declarations are EMITTED, to a writer that writes nothing. Not for the
    // .d.ts files on disk, but for what they say: a checked file's signature
    // is the hash of its `.d.ts`, and only a signature lets a body edit stop at
    // the file — a version (the text's hash) moves on every edit, and its
    // whole importer closure would re-check (measured on web-core, before the
    // keyed engine: a one-line body edit in a file with a thousand importers
    // cost 168 CPU-s and 7.8 GB, the same as cold). Declaration diagnostics
    // come with it: an exported value whose inferred type cannot be written
    // down is a real error. `rootDir` is the repo root so every file has a
    // well-defined output path (without it tsc reports TS6059 for anything
    // outside the tsconfig's own directory). See
    // research/2026-09-09-global-type-check-zone-cut.md, Finding 5.
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    rootDir: root,
    outDir: `${root}/.cache/type-check/decl-out`,
    // A signature must be a function of the code, because the type
    // fingerprints read off it key cached lint results across runs and
    // worktrees. By default it is not: tsc prints inferred object keys and
    // union members in type-CREATION order, which depends on what the checker
    // touched first, so an incremental run (which checks only the affected
    // files) emits a differently ordered `.d.ts` than a cold one for the same
    // tree. Measured 2026-10-17: 228 of 11.8k signatures differed, and each
    // reordered hub re-linted thousands of files for nothing. This hidden TS 6
    // option (no `--help` entry, accepted through the options' index
    // signature) orders types the way TS 7 does: byte-identical output, no
    // measured cost.
    stableTypeOrdering: true,
  };
}
