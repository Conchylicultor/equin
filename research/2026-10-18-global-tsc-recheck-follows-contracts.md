# tsc's re-check follows the `.d.ts` boundary (Rung 2, step 1c)

Task: task-1792341200-c1vvh1 (att-1792341521-h4z2y4). Track: "Track: build and push speed"
(wiki block-e5afc5b1-…). Measurements: "Rung 2 design" sub-page (block-a9e68ab6-…), "Step 1b result".
Previous step: research/2026-10-18-global-typed-lint-key-stops-at-contracts.md.

## Context

Step 1 made typed lint follow what it reads. Its key is a file's text plus its **type fingerprint**:
a Merkle hash over the contract (`.d.ts`) graph from the file's direct imports, plus the global
scope (`shared/type-fingerprint.ts`, `shared/contract-refs.ts`). tsc's own re-check does not stop
there. TS 6's builder (`handleDtsMayChangeOfReferencingExportOfAffectedFile`) walks every
transitive referencer of a file whose signature changed, unconditionally, so a hub API change costs
**~96 CPU-s of tsc**, the same as a cold build. It re-emits all 11.9k declarations and owns the
~21 GB peak. Lint is only 16–23 CPU-s of that run.

The goal is that tsc's diagnostics and signatures are recomputed only for files whose **(text, type
fingerprint)** moved, inside today's single program and without patching TypeScript. Then one key
decides both tsc and lint. Correctness is the risk, because a stale green verdict ships a type
error. Decided with the user:

- **Validate, then switch.** In this task, run the keyed engine against the full check, file by file
  ("dual" mode), on the benchmark scenarios plus a replay of recent main commits. It decides verdicts
  only if 0 files diverge. A daily whole-program backstop on main stays as the safety net.
- **Retire the builder, the `.tsbuildinfo` and the warm-base pool** in this task. They are dead once
  the keyed engine decides.

## Why the key is sound for tsc too

A file's semantic and declaration diagnostics, and its emitted `.d.ts` (so its signature), are a
function of:

- its own text;
- what its checker can see of other files: its direct imports' `.d.ts` and everything those name,
  transitively;
- the global scope;
- the engine: TS version, compiler options, lib/`@types`/`node_modules`.

That is exactly what step 1b's type fingerprint hashes, plus an engine hash. Rung 2's M2 measured
the same claim from the other side: a unit checked against its imports' `.d.ts` gives the whole
program's result in 3,700 of 3,700 units. The builder already relies on the same assumption in a
weaker form (it reuses a file's diagnostics when nothing it references changed signature). Ours is
strictly finer, because the key covers the full contract closure, not one hop.

Known ways this can break (each is caught by dual mode and by the backstop, not assumed away):

1. **Cross-file diagnostic buckets.** Checking G can add an error located in F to F's bucket (for
   example a circularity error reported at the first declaration reached). The builder has the same
   exposure. A full check sees it and a partial check may not.
2. **Checker-order dependence.** Some diagnostics depend on what the checker resolved first. The
   `.d.ts` side is closed by `stableTypeOrdering`, and its purity test already exists.
3. **A reference graph that differs from the builder's `referencedMap`.** Without the builder we
   compute it ourselves (next section). Dual mode compares it edge for edge.

## Design

### 1. The keyed check engine (new: `shared/keyed-check.ts`)

The worker builds a plain `ts.createProgram(rootNames, signatureEmitOptions(...))`, with no builder.
That cost is the parse/bind floor. Then:

- **Versions:** each file's text hash, computed with `ts.sys.createHash`, which is tsc's own version
  function. Declaration inputs (`.d.ts`, `node_modules`) use their version as their shape, as the
  buildinfo did.
- **Reference graph** (`referenceGraph(program)`): a port of the builder's `getReferencedFiles`
  using only public API:
  - each import literal's module symbol → its declaring files (`checker.getSymbolAtLocation`);
  - `/// <reference path>`;
  - resolved type-reference directives;
  - module-augmentation targets;
  - ambient modules declared in more than one file.

  It replaces `readBuildInfoGraph` as the source of `BuildInfoGraph` (renamed `ProgramGraph`).
- **The walk:** Tarjan over the *source* graph. Contract SCCs nest inside source SCCs, because a
  `.d.ts` only names files its source can reach. Components are visited dependencies first. For a
  component, the key is

  `checkKey = H(tscEngineFp, sorted (path, version) of members, typeFp of each member computed over its edges that leave the component)`

  - **Hit** in the file-result store: each member's signature, contract specifiers, semantic
    diagnostics and declaration diagnostics come from the store.
  - **Miss:** `program.getSemanticDiagnostics(sf)` for each member, then a per-file declaration emit
    (`program.emit(sf, writer, undefined, true)`). From that we get the signature (`createHash` of
    the `.d.ts` text, byte-for-byte what the builder stores), the specifiers
    (`contractSpecifiers`) and the declaration diagnostics. All of it is recorded.

  Then the component's contract-SCC hashes are final, and the components that depend on it can
  compute their keys. For a singleton, `checkKey` equals the typed-lint key's inputs, so **one key
  decides both**. A cycle is checked as a whole (coarser, sound). Measure the file-level SCC size
  distribution first. Add an optimistic per-member fixpoint only if large SCCs show up.
- Syntactic, options and global diagnostics are computed every run. They are cheap: parse is
  already done, and the checker is initialised once.
- The type fingerprints for lint come out of the same walk (`computeTypeFingerprints` is
  refactored into an incremental per-component form; it stays pure). `contractEdges`' "emitted
  alone" path disappears, because every miss is emitted anyway.

### 2. The file-result store (new data dir `type-check-file-results`)

`shared/pass-set.ts` pattern, host-wide, content-addressed, with an age and count bound like the
lint store's. The key is `checkKey`. The value per member:
`{ signature, specs: ContractSpecifiers, semantic: string[], declaration: string[] }`, with
diagnostics pre-formatted with repo-relative paths. It supersedes `type-check-contract-refs`, which
is retired.

The **tsc engine fp** covers:

- the TS package version;
- the canonical compiler options;
- `lockfileLintDigest`;
- `patches/**`;
- the engine sources: `keyed-check.ts`, `type-fingerprint.ts`, `contract-refs.ts`,
  `emit-options.ts`.

Reuse the engine pieces in `check/lint-groups.ts` rather than restating them. The typed-lint
engine folds this fp in, so the two cannot drift.

### 3. Modes (`job.tscMode`, a closed union in `core/worker-protocol.ts`)

- `keyed`: the default after validation. The verdict comes from the walk.
- `dual`: the walk first, then a **full** check of the same program (every file's
  `getSemanticDiagnostics` / declaration emit). For each file it compares diagnostics, signature and
  reference edges, and it reports each divergence (file, kind, both sides) as a result field plus a
  transcript line. The verdict is the full check's. Used for validation runs and by the backstop.
  Never default.

### 4. Retire the builder, the buildinfo and the warm base

- The program key's loaded set `L` (`check/program-key.ts`) comes from a **program manifest** the
  worker writes after every run (`.cache/type-check/program-manifest.json`: every
  `program.getSourceFiles()` path). It replaces `readProgramFileList` (`checks/core/buildinfo.ts`)
  as the enumeration. The envelope argument is unchanged.
- Delete:
  - `checks/core/warm-base.ts`, `warm-base-git.ts`, `buildinfo.ts` and their tests;
  - the `tsbuildinfo` data dir and `tsBuildInfoPath`;
  - the warm-base steps in `check/prepare.ts` (`materializeWarmBase`, `publishWarmBase` in
    `finalize`);
  - the same steps in the build fast path (`cli/plugins/build/cli/internal/app-artifacts.ts`).

  `content-hash.ts` stays if the program key still uses it.
- `finalize` recomputes the built key from the manifest instead of the buildinfo.
- Update `type-check/CLAUDE.md`: the "Which base a fresh worktree starts from" section goes, and the
  one-program section's "tsc's own incremental engine" wording is replaced by the keyed engine.

### 5. Backstop

A daily `defineJob` in the type-check plugin's `server/` runs only on main. It runs the worker in
`dual` mode on main's tree, cold program, with the store warm. Any divergence files a report
through the reports plugin (fingerprinted per file + kind) and **evicts** the offending store
entries. The job is not part of any build. It is the same harness Rung 2 step 2 needs for its
shadow mode.

### 6. Correctness gates before switching the default

1. A unit test (`shared/keyed-check.test.ts`) on small fixture programs:
   - body edit, export edit, the 2-hop `D→E→G` chain, a cycle, an augmentation, an added
     file that shadows a resolution, an unresolved import becoming resolved.

   Each one compares the keyed walk with the full check.
2. A purity test: the same tree from a cold store and from a store warmed on a different tree gives
   identical per-file results.
3. **Dual mode on the 11 benchmark scenarios, and a replay of the last ~30 main commits that touch
   `.ts`.** Apply each commit on a store warmed on its parent. Gate: 0 divergences.
4. `scripts/typed-key-oracle.ts` re-run on the 6 scenarios. The key's inputs are unchanged, so it
   should give 0 misses.

## Benchmark (put on the design sub-page, a new "Step 1c result")

Method as in step 1b:

- two checkouts, one per side, with separate `SINGULARITY_DIR`;
- before = main at this task's merge-base, after = this branch;
- warm cold on the base tree, snapshot, then per scenario: restore, patch,
  `./singularity check type-check --jobs 1`, reverse.

Report the worker's phase line, which gains a split: `tsc (build | keyed walk: N hit / M checked |
emit)`, type fps, lint, and maxRSS. Same 11 scenarios as the step 1b table. Also report:

- the identical-tree floor;
- the cold run (store empty);
- **fresh worktree on main's tree with the host store warm** (previously served by the warm base).

Expected, not measured: hub type edit tsc ~98 → ~45 CPU-s, a976 ~96 → ~23, narrow API changes near
the 8.5 s floor, and a lower peak on wide changes. Then update the track page's status, the
checklist (step 1c) and the "Next" line, and file the next main task (step 2,
task-1792312301-fcfodz already exists, so confirm it is still next rather than duplicating it).

## Critical files

- New: `type-check/shared/keyed-check.ts` (+ test), `type-check/shared/file-results-store.ts`,
  `type-check/server/` backstop job.
- Changed:
  - `type-check/shared/worker.ts` (builder → program + walk; modes; phase split; manifest write);
  - `shared/type-fingerprint.ts` (incremental per-component hashing; `ProgramGraph` instead of
    the buildinfo reader);
  - `shared/contract-refs.ts` (keep `contractSpecifiers`/resolution, drop the store fallback);
  - `core/worker-protocol.ts`;
  - `check/prepare.ts`;
  - `check/program-key.ts`;
  - `check/lint-groups.ts` (tsc engine fp);
  - `type-check/data-dirs`;
  - `checks/core/index.ts`, `checks/data-dirs`;
  - `cli/plugins/build/cli/internal/app-artifacts.ts`;
  - `scripts/typed-key-oracle.ts` (graph source);
  - `type-check/CLAUDE.md`.
- Deleted: `checks/core/{warm-base,warm-base-git,buildinfo}.ts` (+ tests),
  `type-check/shared/contract-refs-store.ts`.

## Verification

- `./singularity test plugins/framework/plugins/tooling/plugins/checks` (unit, purity, program-key
  tests updated for the manifest).
- Dual-mode gate (§6.3) with 0 divergences before `tscMode` defaults to `keyed`.
- `./singularity check` green and `./singularity build` green on the branch.
- The benchmark table on the wiki sub-page, and the track page updated.

## Out of scope

- Units and per-unit processes (step 2–3).
- Keys per used symbol (step 4): the hub edit still re-checks the ~5,155 files its barrel exposes
  the change to.
- TS 7 (step 5). This step removes the buildinfo dependency, so it makes step 5 easier. The engine
  touches only about five public program/checker calls.
