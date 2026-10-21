# Rung 2 step 2, v2: two programs sized by changed names

Supersedes the unit design of research/2026-10-19-global-rung2-unit-checker-shadow.md after its
Phase A (results on the design page, section "Step 2, Phase A"). Task: task-1792312301-fcfodz
(att-1792413968-s2bio1). Track: "Track: build and push speed" (block-e5afc5b1-…); design page
block-a9e68ab6-….

## Why v2

Phase A: units checked against contracts give exactly the whole program's diagnostics, at
1.5 GB per process instead of 7 GB, but cost more CPU than step 1c (replay median 65 vs 46
CPU-s). A unit key covers every contract file the unit loaded, so units re-check 2–8× more files
than 1c (hub edit 7,543 vs 1,335). The useful part of rung 2 is loading less, not the unit key.

Decided with the user: keep step 1c's per-file, per-name keys, and load only what a run checks,
in at most two programs, sized up front (no recursive program building).

## Design

1. **Program 1: the changed files.** Changed files as source, every other import served as its
   stored `.d.ts`. Check them, emit their `.d.ts`, diff old vs new per exported name. No name
   changed → done.
2. **Affected set, no TypeScript.** From the changed names, follow stored edges:
   - name-use edges (file → declaring file#name, step 1c's `contract-refs`);
   - inference edges, recorded at check time: an exported declaration without a written type →
     the outside names its inferred type was computed from.
   Closure over both = every file whose diagnostics or `.d.ts` can move. Global files changed →
   everything, as in 1c.
3. **Program 2: the affected set** as source, the rest as stored `.d.ts`. Check all of it.

Two programs is the minimum: which names changed is known only after checking the changed files
(inferred types). Merging would treat every name of a changed file as changed.

## Prototype and measurement (probe only, nothing in the check path)

- `scripts/unit-probe.ts` gains a subcommand for this mode, reusing `unit-host.ts` (serving
  stored `.d.ts`), `keyed-check.ts`'s `checkFile` / `canonicalDeclarations`, and
  `contract-refs.ts`.
- Store per file: canonical `.d.ts` text per exported name, name-use edges, inference edges.
- Correctness: per scenario and per replayed commit, diagnostics equal a full check of a fresh
  whole program (0 divergences), and no file outside the affected set whose diagnostics or
  `.d.ts` changed.
- Before/after with isolated `SINGULARITY_DIR` per side: the 14 step 1c scenarios, unchanged
  tree, and the 31-commit replay (48d95e56d9 → 4e1e2c0e65). Columns: CPU, peak RSS, wall,
  files loaded as source per program, files checked, cost of computing the set, and files added
  by inference edges alone.

If it wins, it replaces the unit design on the design and track pages, and the shadow step is
re-planned around it.
