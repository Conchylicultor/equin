# Drop the vestigial ESLint git-scoping layer (Plan 2 / cleanup)

## Context

Plan 1 (`research/2026-06-08-cli-eslint-closure-keyed-cache.md`, landed in commit
`cdc4dc7f2`) replaced ESLint's content-`--cache` with a **dependency-closure-keyed
per-file cache** living in `eslint/core`. A file is re-linted iff its content *or*
its transitive forward-import closure content changed; otherwise its PASS is served
from a content-addressed cache shared across runs and worktrees.

That made the **git-driven scoping layer vestigial.** Plan 1 deliberately *kept* it
as a candidate-narrowing fast path, but with the closure cache in place a **full**
candidate set (`graphs.files`, all ~2569 lintable files) is already cheap: every
file except genuinely-changed closures is a cache hit, so narrowing the candidate
set via `git diff` no longer buys correctness — only a marginal reduction in how
many fingerprints get computed. Worse, the scoping makes build/push/check run
*three different candidate-derivation paths* over the same tree and forces the
outer check-cache key to fold in a per-context scope hash.

**Goal:** collapse build/push/check onto **one path** — the eslint check always
fingerprints the full lintable set and lets the closure cache decide what to
re-lint — and delete the now-dead git-scoping code. The `eslint/core` graph +
fingerprint + cache primitives survive untouched; the git-diff scoping does not.

## Verification of the gating assumption (already measured)

The task's precondition is: *the full-set fingerprint-diff path must be fast enough
(cache warm) to replace git-scoping without regressing build/push latency.* Measured
on this worktree (2569 lintable files, `buildImportGraphs` + `computeClosureFingerprints`
over the full set, the per-run cost that **cannot** be cached away):

| Phase | Cold-ish | Warm fs |
|---|---|---|
| `buildImportGraphs(root)` | 763 ms | ~0.8–1.1 s |
| `computeClosureFingerprints(root, graphs, graphs.files)` | 521 ms | ~0.5–0.8 s |
| **Full-set per-run overhead** | **~1.3 s** | **~1.3–1.9 s** |

(avg closure size 77, max 378.)

**This is not a regression — it's a wash or a slight win.** The *current* scoped
path builds the import graph **twice** per build/push: once inside
`computeAffectedFiles()` (to BFS the reverse map) and again inside the check's
`run()` (forward map for fingerprints) ≈ **~1.6 s of graph building**, plus a tiny
scoped fingerprint. Collapsing onto the full-set path **eliminates the redundant
`computeAffectedFiles` graph build**; the single remaining graph build plus the
full fingerprint (~1.3–1.9 s) replaces that ~1.6 s. The cache-warm eslint spawn is
skipped (`toLint` empty) in both worlds. **Gate satisfied.**

## Changes

### 1. Delete `plugins/framework/plugins/cli/bin/eslint-affected.ts` entirely

Every export becomes orphaned once build/push stop scoping:
- `computeEslintScope` — already **zero** references repo-wide (build switched to
  `computeAffectedFiles` in Plan 1).
- `computeAffectedFiles` — only callers are build.ts + push.ts (both removed below).
- `changedFilesVsMain`, `isForceFull`, `gitText` — only used internally by the above.

No other file imports from `eslint-affected.ts`. The force-full trigger logic it
held is **already duplicated** as `isGlobalTrigger`/`globalConfigFingerprint` in
`eslint/core/fingerprint.ts` (the canonical home now), so nothing is lost.

### 2. `plugins/framework/plugins/cli/bin/commands/build.ts`

- Remove the import (line 8): `import { computeAffectedFiles } from "../eslint-affected";`
- Remove the scope block (lines ~771–782): the
  `if (branch !== "main") { const scope = await computeAffectedFiles(root); … SINGULARITY_ESLINT_SCOPE … }`
  and its preceding comment. The in-process `runChecks(...)` call (line ~800) then
  runs the check with no scope env → full set.

### 3. `plugins/framework/plugins/cli/bin/commands/push.ts`

- Remove the import (line 10).
- Delete `resolveEslintScope()` (lines ~101–118) entirely, including its
  `lint-full` / `lint-scoped` profiler steps (these step names are referenced
  nowhere else — the push Gantt renders whatever steps exist; the `checks` step
  still covers the lint work).
- Drop the `scopeEnv` parameter from `runChecksUnderPushSlot()` and
  `runChecksSubprocess()`, and remove the `if (scopeEnv !== undefined) env.SINGULARITY_ESLINT_SCOPE = scopeEnv;`
  block plus the long `scopeEnv` doc comment (lines ~41–48).
- Update the two call sites (lines ~435–436 and ~549–550): drop the
  `const scopeEnv = await resolveEslintScope(...)` line and the `scopeEnv` argument
  to `runChecksUnderPushSlot(...)`. Trim the now-stale "Affected-set scope" comments
  (lines ~433, ~545–548).

### 4. `plugins/framework/plugins/tooling/plugins/checks/plugins/eslint/check/index.ts`

- Delete `eslintScope()` and the `SINGULARITY_ESLINT_SCOPE` read (lines ~24–38).
- Delete `cacheSignature()` (lines ~44–53). With the candidate set now a pure
  function of the tree, a per-context signature is meaningless: an absent
  `cacheSignature` makes the runner key the outer check-cache on the tree hash
  alone (`runner.ts:82`), so build and push at the same tree hash **share** the
  entry automatically. Drop `cacheSignature?` from the local `Check` type and
  remove the now-unused `import { createHash } from "crypto";`.
- Rewrite `run()` to always lint the full set:
  ```ts
  async run() {
    const root = await getRoot();
    const graphs = buildImportGraphs(root);
    const { perFile } = computeClosureFingerprints(root, graphs, graphs.files);

    const cache = openEslintClosureCache();
    const toLint = graphs.files.filter((f) => {
      const fp = perFile.get(f);
      return !fp || !cache.has(f, fp); // unreadable fingerprint → lint to be safe
    });
    if (toLint.length === 0) return { ok: true };
    // … unchanged: spawn `eslint ...toLint --quiet`, record PASSes on exit 0 …
  }
  ```
  The eslint spawn, per-file PASS recording, and failure handling are unchanged.

### 5. `plugins/framework/plugins/tooling/plugins/checks/plugins/eslint/core/`

Keep `ImportGraphs.reverse` and `buildImportGraphs` building both maps in the single
walk (the reverse map is free and is the general graph primitive the task preserves).
**Delete only the orphaned standalone wrapper** whose sole purpose was the deleted
scoping:
- `import-graph.ts`: remove `export function buildReverseImportGraph(root)` (lines
  ~241–250) and its docstring (it literally reads "for callers that only need the
  reverse map (the cli affected-set scoping)").
- `index.ts`: drop `buildReverseImportGraph` from the re-export list (line 3).

### 6. Regenerated, no manual edit

- `eslint/CLAUDE.md` "Plugin reference" block is fully autogenerated — `./equin build`
  drops `buildReverseImportGraph` from the exports list.
- `docs/plugins-compact.md` / `docs/plugins-details.md` regenerate on build; the
  `plugins-doc-in-sync` check enforces it.

## Net result

One path everywhere: build, push, and `./equin check` all run the eslint check
with **no scope env**, fingerprinting the full lintable set and letting the closure
cache skip unchanged closures. Deleted: an entire bin file, one env var across three
commands, two profiler steps, the per-context `cacheSignature` branching, and one
orphaned graph wrapper. The `eslint/core` graph/fingerprint/cache primitives are
untouched (minus the dead reverse wrapper).

## Critical files

- `plugins/framework/plugins/cli/bin/eslint-affected.ts` *(delete)*
- `plugins/framework/plugins/cli/bin/commands/build.ts` *(remove import + scope block)*
- `plugins/framework/plugins/cli/bin/commands/push.ts` *(remove scope plumbing + `resolveEslintScope`)*
- `plugins/framework/plugins/tooling/plugins/checks/plugins/eslint/check/index.ts` *(rewrite `run`, drop `eslintScope`/`cacheSignature`)*
- `plugins/framework/plugins/tooling/plugins/checks/plugins/eslint/core/import-graph.ts` *(drop `buildReverseImportGraph`)*
- `plugins/framework/plugins/tooling/plugins/checks/plugins/eslint/core/index.ts` *(drop re-export)*

## Verification

1. **Type-check / no dangling refs.** `./equin build` succeeds; the `typescript`
   check passes (confirms no lingering imports of `eslint-affected` or
   `buildReverseImportGraph`, and `SINGULARITY_ESLINT_SCOPE` is fully gone:
   `rg SINGULARITY_ESLINT_SCOPE` → no hits).
2. **Cross-file violation still caught (soundness unchanged).** On a branch: `A.ts`
   exports a type used by `B.ts`; both PASS. Edit `A.ts` so the type now trips a
   rule in `B.ts` (B's bytes unchanged) → `./equin check eslint` FAILS. The
   closure cache, not the scope, provides this — the deletion must not regress it.
3. **Build→push share the outer check-cache.** On a branch with a typed change:
   `./equin build` (eslint `ok`); without touching the tree, `./equin push`'s
   spawned `check` logs `eslint … ok (cached)` — same tree hash, no `cacheSignature`,
   so one shared entry.
4. **Latency parity.** Time the eslint check warm-cache (`toLint` empty) on a
   non-trivial branch; confirm it's in the ~1.3–1.9 s band measured above and not
   worse than the pre-change scoped path. (`build-profile.json` `check:eslint`
   step, or temporarily log the two `performance.now()` deltas.)
5. **Config invalidation intact.** With a warm cache, touch `eslint.config.ts` →
   `globalConfigFingerprint` flips → every `fp` changes → non-trivial `toLint`
   (unchanged from Plan 1; verifies the global trigger path still drives invalidation
   now that it's the *only* "lint infra changed" mechanism).
