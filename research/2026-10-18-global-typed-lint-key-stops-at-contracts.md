# Typed lint key stops at unchanged contracts (Rung 2, step 1, second half)

Task: task-1792272254-uyqmyd (att-1792295421-dqbtng). Track: "Track: build and push speed"
(wiki block-e5afc5b1-…). Design page: "Rung 2 design" (block-a9e68ab6-…), section "Step 1 result".
First half: att-1792238889-bnwy01, research/2026-10-17-global-lint-keyed-on-what-it-reads.md
(on main as 28fa19e699).

## Context

Step 1's first half split each file's lint result into a syntactic part (keyed on the file's text)
and one typed part. The typed part is keyed on the file's text, all type-aware rules, and a **type
fingerprint**. Body edits now re-lint 1 file instead of 6,432. Three things are still wrong. The
first two are the main items, the third is small:

1. **The type fingerprint is transitive over the source graph.** `shared/type-fingerprint.ts`
   hashes the signature of every file reachable through tsc's `referencedMap`, which is the
   *source* import graph. So an exported-type edit in `web-sdk/core/registry.ts` moves the
   fingerprint of everything that can reach it: 8,553 typed re-lints. Revert of a976e508b8 gives
   8,435, against 2,656 under the old closure key. The chain never stops at an importer whose own
   `.d.ts` did not change.
2. **One typed group for all type-aware rules.** `LINT_GROUP_TYPED` is keyed on every type-aware
   rule at once, so editing one re-runs all of them on every file (75.7 → 132.4 CPU-s, a
   regression against the merge-base).
3. Minor items: (a) a typed or syntactic key that gets reused is never moved to the front of its
   entry's list, so `keepTyped: 3` can evict it while it is still in use; (b) a syntactic-only
   rule edit still runs the full tsc program.

The exit criterion is unchanged: files linted per run, worker CPU and memory follow what lint
reads. It must be correct within today's single program, with no all-or-nothing cache.

## What a typed result actually reads

A type-aware rule reads the file's text plus the checker's types for it. Those types are a function
of the file and of the **declarations it can name**:

- the `.d.ts` of each file it imports directly (its `referencedMap` successors);
- every file those `.d.ts` name in turn: `export … from`, `import type`, and the
  `import("./e").T` that tsc writes for an inferred type (`export type U = T`, a return type
  that comes from elsewhere). Then whatever *those* `.d.ts` name, and so on. This closure runs over
  the `.d.ts`→`.d.ts` graph, not the source graph;
- the global scope (lib, `@types`, `declare global`), plus module augmentations (see below).

**One hop is not enough.** Say `D.d.ts` says `x: import("./e").T` and `E.d.ts` says
`type T = import("./g").G`. If G changes, then `D.d.ts` and `E.d.ts` are byte-identical, but the
type of `D.x` that f sees has changed. So the key has to follow the **declaration graph** to its
end. It still stops where it should: if an importer's `.d.ts` does not name the changed file, the
change cannot reach that importer's own importers through it. This is exactly what the Rung 2
prototype loaded per unit ("contracts a unit loads: median 66–82 `.d.ts`"), and it gave 0 of 3,700
divergences.

Why `.d.ts` text is a complete stand-in for the source: the worker treats declaration
diagnostics as errors (`getDeclarationDiagnostics`). So every inferred type that leaks into an
export can be written down, with no TS2742/TS4023 errors and no truncation (TS7056), and the
`.d.ts` says everything an importer's checker can learn.

Two properties hold by construction:

- **Never wider than the old keys.** Declaration edges only reach files that are reachable in the
  source graph, and a changed signature implies changed text. So the re-linted set is a subset of
  today's typed key and of the old closure key. For a976 that means ≤ 2,656, where today gives
  8,435.
- **Never narrower than tsc.** tsc re-checks the direct referencers of a file whose signature
  changed, plus the chain of files that re-export it (`handleDtsMayChangeOfReferencingExportOfAffectedFile`).
  The declaration closure contains both.

## Design

### 1. The contract graph (new: `shared/contract-refs.ts`, pure)

`contractRefs(dtsText) → string[]` takes one file's emitted `.d.ts` and returns the module
specifiers it names. It walks the AST from `ts.createSourceFile`, never a regex. It collects
`ImportDeclaration`, `ExportDeclaration` and `ImportEqualsDeclaration` module specifiers,
`ImportTypeNode` arguments, `/// <reference path|types>`, and `declare module "x"` names.

Since a signature is tsc's hash of exactly that `.d.ts` text (`computeSignatureWithDiagnostics`),
the specifiers are a pure function of **(signature)**. They go in a host-wide, content-addressed
store keyed by `(rel, signature)`: new data dir `type-check-contract-refs`, the `pass-set`
pattern, with an age bound. Resolution is never stored. Specifiers are resolved on every run from
the file's source location: `program.getResolvedModule` for specifiers the source also imports,
otherwise `ts.resolveModuleName` with the program's options and one shared resolution cache. The
`outDir` mirrors the tree under `rootDir: root`, so a relative specifier written for the output
file resolves the same way from the source. That means a new file that shadows a resolution can
never leave a stale edge.

Edges by file kind:

- **`.ts`/`.tsx` source**: resolved specifiers of its `.d.ts`.
- **Declaration input** (`node_modules`, ambient `.d.ts`): its `referencedMap` successors, which
  are exactly its imports.
- **JSON**: none.

### 2. Where the specifiers come from (worker)

- The emit writer already sees every `.d.ts` the incremental emit produces. The 5th argument,
  `sourceFiles`, maps each one back to its source. The worker records `(rel, new signature) →
  specifiers` for those files, reading the new signature off the buildinfo it just wrote.
- A source file whose `(rel, signature)` is not in the store yet gets its declaration emitted on
  its own: `program.emit(sf, writer, undefined, /*emitOnlyDts*/ true)` on `builder.getProgram()`.
  This leaves the builder state alone. It happens once per host per file version. The first run
  after landing emits them all, about 11.7k (cost measured, see the benchmark). After that it is
  only files that a pooled warm base brought in at a version this host never emitted.
- There is no fallback to source edges. The store is filled first, so a missing entry is a bug
  and throws.

### 3. The fingerprint (`shared/type-fingerprint.ts`, still pure)

`computeTypeFingerprints(buildInfoText, dir, root, contractEdges, augmenters)`:

- `cHash(D)` is a Merkle hash over the SCC condensation of the **contract** graph: D's `(path,
  sig)` plus the cHash of each component it names. This is the same iterative Tarjan as today, run
  on a different edge set.
- `globalFp` covers the signatures of every `affectsGlobalScope` file **plus every file with a
  module augmentation**. Today 2 such files exist: `declare module "@tanstack/react-query"` and
  `"bun:jsc"`. Today's key misses an edit to them. A file that imports react-query sees the
  augmentation, but nothing in its graph reaches the augmenting file. The worker passes them in
  from `sf.moduleAugmentations`.
- `typeFp(f) = H(globalFp, sorted cHash(D) for D in referencedMap(f))`, built from f's **source**
  edges (what it imports directly), never f's own signature, because f's text is already in the
  store key. Still O(V+E).

The signature table (`type-fp-tables.ts`), the prepare/worker split (`TypedDecision`) and the
program skip are unchanged. Only the value a table holds changes, and `type-fingerprint.ts` is
already an engine source (see 5).

### 4. One typed part per rule group

`LINT_GROUP_TYPED` goes away. Every group that holds a type-aware rule gets its own typed part:
base, plus each contribution with one (about 8, from `typeAwareLintGroups`). This mirrors the
syntactic groups:

- Key: `typedResultKey(groupFp, typeFp)`. `typedGroupFp` becomes `typedGroupFps(groups,
  typeAware) → Map<group, fp>`. The throw on a type-aware contribution with no group stays.
- Protocol (`core/worker-protocol.ts`): a split unit's `typed` becomes per part: `{ kind:
  "decided"; stale: { group, key }[] }` (from a table) or `{ kind: "deferred"; parts: { group, fp
  }[]; known: string[] }`. The outcome lists `{ group, key, ran | cached }` per part. The `whole`
  unit (directive files, keyed on `allFp`) is unchanged.
- Worker: for each file, the stale typed groups run in ONE `verify` with a config that registers
  only those groups' type-aware rules (`kind: "type-aware"`, memoized per group set like
  `syntacticConfig`). Messages are split by `groupOf(ruleId)`. So when every part is stale (cold,
  or a moved type fingerprint), the cost is the same one pass as today. When one rule changed, only
  that group runs.
- Store: `keepTyped` becomes `3 × typed groups`. Transcript: the stale breakdown names typed parts
  as `(types) <group>`.

### 5. Small items

- **Reused keys move to the front.** `LintEntryUpdate` gains the keys this run reused, both from
  prepare's fresh hits and from the worker's `cached` outcomes. `mergeKeys` orders the list as
  fresh, then reused, then the rest. `finalize` rewrites an entry only when that order differs
  from the stored one. In steady state that is zero extra writes. Two worktrees alternating on two
  versions of a hub then keep each other's keys instead of evicting them.
- **The typed-key code keys the typed parts only.** `type-fingerprint.ts`, `contract-refs.ts` and
  `emit-options.ts` move out of the shared engine into a "typed engine" hash that only typed and
  whole parts fold in. Editing the type-fingerprint code then no longer re-runs every syntactic
  result. This landing still changes the engine once, so the first run per host is a full lint,
  as the earlier landings' were.
- **A syntactic-only rule edit runs tsc: not a step 1 bug.** A rule's source file is a root of
  the one program, so editing it changes the program key and tsc has to re-check that file. The
  cost is the program-load floor (about 38 CPU-s) plus the syntactic pass. I will confirm that
  split from the worker's phase timings in the benchmark and close the item on the page as
  "removed by step 3" (units), rather than special-casing it.

## Correctness

- **Oracle script** (new, `scripts/typed-key-oracle.ts` in the type-check plugin; manual). Given
  two trees, it builds both programs with `signatureEmitOptions`. For every file it computes a
  digest of what a typed rule can observe: `checker.typeToString(getTypeAtLocation(n),
  NoTruncation)` and the symbol flags for each identifier and expression node. It also computes the
  new type fingerprints. It asserts that every file whose digest changed has a changed type
  fingerprint, and it reports the over-invalidation ratio (fingerprint moved, digest did not). I
  run it on every benchmark scenario, plus a hand-made `export type U = T` chain three files deep
  and an edit to the react-query augmentation. Any miss blocks the landing.
- **Unit tests** (`type-fingerprint.test.ts`, extended):
  - a chain stops at an importer whose `.d.ts` does not name the changed file;
  - a re-export passes through;
  - an inferred `import("./e").T` passes through, at depth 3;
  - cycles;
  - an augmenter counts as global;
  - a node_modules `.d.ts` uses its `referencedMap` edges.

  The existing real-program test (a small TS project in a temp dir) gains a `.d.ts`-naming case.
  The check-order purity test stays. New `contract-refs.test.ts` covers the specifier extraction.
- **Lint-cache tests** (`lint-cache.test.ts`, `prepare-thread.test.ts`):
  - a per-group typed key moves only with its group;
  - a reused key moves to the front, and no write happens when the order is unchanged.
- **Re-survey the type-aware rules**: the 7 custom ones, the 4 from typescript-eslint, and
  `no-floating-promises`. Check that none reads a declaration's *source* body through
  `symbol.getDeclarations()`, because that would read past the contract. The declaring file's
  path, which `allowForKnownSafePromises` reads, is fine: it is always in the closure.

## Benchmark (exit criterion)

The method is the design page's "Step 1 result" method:

- Before is main at this branch's merge-base, which already includes the first half. After is
  this branch.
- Two checkouts with separate lint, table and contract-refs stores, so no fleet result leaks in.
  Each side is warmed on the base tree, and its stores and buildinfo are snapshotted.
- Each scenario restores the snapshot, applies one edit, and runs `./singularity check
  type-check --jobs 1`.
- Read the `lint N/M` line, the typed-part counts and the worker `cpu` / `maxRSS` line.

Scenarios:

- the same 11 as the page: hub and mid-size body edits, exported-type edits in a leaf and in the
  hub, a syntactic rule edit, a type-aware rule edit, and reverts of 6e5d5e8cb7, e072a220eb,
  a976e508b8, b369bec11c and 9424cf1133;
- one more: a re-export chain edit.

Also measured:

- the cold cost of filling the contract-refs store (the first run on an empty store);
- the steady-state overhead per warm run: store reads, resolution and fingerprinting, against the
  38 CPU-s floor;
- the store's size.

Expected, to be confirmed:

- a hub exported-type edit drops from 8,553 typed re-lints to the hub's declaration-reach. The
  barrel re-exports `registry`, so its 1,078+ importers stay; the rest falls away;
- a976 drops to ≤ 2,656;
- the type-aware rule edit drops back to about 75 CPU-s;
- body edits unchanged.

The results go on the design page as a third column, "after step 1b", in the same table. The
track page's status, overview checkboxes and "Next" line get updated. Then I file the single next
task: Step 2 (unit checker in shadow mode) and the fleet slot-wait confirmation, with the page id.

## Files

- `checks/plugins/type-check/shared/`:
  - `type-fingerprint.ts`: contract-graph Merkle, augmenters folded into the global hash;
  - `contract-refs.ts` (new) and its test;
  - `worker.ts`: specifier capture, forced per-file `.d.ts` emit for misses, resolution,
    per-group typed passes;
  - `type-fingerprint.test.ts`.
- `checks/plugins/type-check/core/`:
  - `worker-protocol.ts`, `index.ts`: per-group `TypedDecision` / `TypedOutcome`;
  - `LINT_GROUP_TYPED` removed.
- `checks/plugins/type-check/check/`:
  - `lint-groups.ts`: `typedGroupFps`, the typed-engine split;
  - `prepare.ts`: per-group decide and record, reused-key touch, transcript;
  - `lint-results.ts`: reuse ordering, `keepTyped`;
  - (the contract-refs store is opened by the worker, so it lives beside it in `shared/`, or the
    worker gets it from the job, whichever the boundary table allows for `shared` → `data-dirs`);
  - `lint-cache.test.ts`, `prepare-thread.test.ts`.
- `checks/plugins/type-check/data-dirs/index.ts`: `type-check-contract-refs`.
- `checks/plugins/type-check/scripts/typed-key-oracle.ts` (new).
- `checks/plugins/type-check/CLAUDE.md`: the lint-cache section.
