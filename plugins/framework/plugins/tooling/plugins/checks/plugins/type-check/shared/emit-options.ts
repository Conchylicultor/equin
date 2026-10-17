// The compiler options the worker builds the program with, on top of the
// tsconfig's own: what makes every file in the `.tsbuildinfo` carry a real
// signature, and that signature a pure function of the code. One function so
// the worker and the test that holds its purity (`./type-fingerprint.test.ts`)
// cannot drift apart.

import type ts from "typescript";

/**
 * `base` (the parsed tsconfig's options) with declaration emit to `outDir`
 * (named, never written: the worker's writer keeps only the buildinfo) and an
 * incremental buildinfo at `buildInfoPath`.
 */
export function signatureEmitOptions(
  base: ts.CompilerOptions,
  root: string,
  buildInfoPath: string,
): ts.CompilerOptions {
  return {
    ...base,
    // Declarations are EMITTED, to a writer that keeps nothing but the
    // buildinfo. Not for the .d.ts files — nothing reads them — but for what
    // computing them puts INTO the buildinfo: a real per-file signature, the
    // hash of each file's public shape. Under `noEmit` tsc stores a placeholder
    // (signature = version) for every file, so it cannot tell a body edit from
    // an API change and re-checks a hub's entire importer closure either way:
    // measured on web-core, a one-line body edit in a file with a thousand
    // importers cost 168 CPU-s and 7.8 GB, the same as cold. With real
    // signatures the same edit costs the identical-tree floor, 38 CPU-s and
    // 2.5 GB; an edit that changes an API still re-checks its importers, as it
    // must. `rootDir` is the repo root so every file has a well-defined output
    // path (without it tsc reports TS6059 for anything outside the tsconfig's
    // own directory). See research/2026-09-09-global-type-check-zone-cut.md,
    // Finding 5.
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    rootDir: root,
    outDir: `${buildInfoPath}.decl-out`,
    incremental: true,
    tsBuildInfoFile: buildInfoPath,
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
    // measured cost. `affectsBuildInfo`, so turning it on re-checks once.
    stableTypeOrdering: true,
  };
}
