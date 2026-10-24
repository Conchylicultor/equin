# Affected-set ESLint on `./equin push`

## Context

Every `./equin push` runs the `eslint` and `typescript` checks on the rebased tree —
this is the **authoritative gate**: it's exactly what lands on `main`. Today push runs
`eslint .` over the whole repo (~2256 files). When the per-worktree `.cache/eslint`
content-cache is cold (which happens on a worktree's first push, because ESLint invalidates
the cache wholesale on config-hash drift), that full lint takes **~591 s**. A 2-file change
pays the same as a 200-file change.

The build path already solved its own cold-lint problem by diff-scoping eslint to the changed
files (`research/2026-06-05-global-cold-build-speedup.md`), but it **deliberately left push
full-repo** "so the complete type-aware gate is preserved." We now want push fast too —
**without letting any violation escape to `main`.**

### Why naive diff-scoping is unsafe on push (the constraint)

ESLint enables **type-aware** rules that can fail a push (all `error`, and `--quiet` keeps
only errors): `promise-safety/no-floating-promises`, `@typescript-eslint/no-misused-promises`,
`switch-exhaustiveness-check`, `await-thenable`. For these, a change in file **A** can introduce
a violation in an **unchanged** file **B** (e.g. you make a function return a `Promise`; an
existing unawaited call in B is now a floating promise). Diff-scoping lints only A, so B's new
violation lands on `main`. **This is unacceptable** — push must catch it.

Crucially, this gap is **not unique to diff-scoping**: ESLint's `--cache` keys each file on its
*own* content, so a *warm* full `eslint .` also returns B's **stale** cached result and misses
the same case. Only a *cold* (cacheless) full lint catches it today — i.e. the slow path is the
only sound one. So "keep full lint" and "warm the cache" do **not** by themselves meet the bar.

### The insight that shapes the design

- **`tsc` already does the cross-file work for type *errors*.** `tsc --incremental` builds the
  file dependency graph and soundly re-checks every file affected by a change. It already runs
  incrementally on push (`--incremental --tsBuildInfoFile`, seeded from main). So all cross-file
  **type errors** are already caught on every push, fast. **`tsc` needs no change.**
- The residual gap is exactly the handful of **type-aware ESLint rules above**, which are not
  type errors. To catch them soundly we must lint **B**, and we only need to lint B when B's
  types depend on A — i.e. B (transitively) **imports** A.

**Therefore:** on push, lint the **affected set** = changed files **+ every file that transitively
imports a changed file**. This is sound for the type-aware rules (an unchanged file can only be
affected through an import edge), strictly *closes the gap that exists even today*, and is fast —
the set is tiny for a leaf change and grows only with real blast radius. The import graph is a
sound over-approximation of the type-dependency graph (you cannot reference A's types in B without
importing from A, directly or via a re-export chain — the one exception, global/ambient
declarations, is handled by a force-full trigger).

## Decision

Diff-scope push's eslint to the **file-level affected set**, computed from a self-contained import
graph built at push time. Force a **full** `eslint .` when correctness requires it (lint
rules/config/tsconfig/deps changed, an ambient `.d.ts` changed, the graph is undeterminable, or on
`main`). Leave `tsc` unchanged. Build keeps its existing looser diff-scope (it is non-authoritative;
push is its backstop).

### Why not the alternatives

- **Reuse tsc's affected set directly** — conceptually DRY, but requires either parsing the
  internal, version-specific `.tsbuildinfo` `referencedMap` (fragile; violates "don't build on a
  broken assumption") or rewriting the tsc check onto the TS BuilderProgram API (heavy). Our own
  import graph is robust, self-contained, ~1–2 s to build, and a sound over-approximation.
- **Warm/shared full cache** — fixes speed but not the cross-file gap (stale `--cache` hits), and
  the force-full-on-config path is inherently cold anyway. Doesn't meet the "no escapes" bar.
- **Plugin-level affected set** — simpler but coarser: editing one internal file in a load-bearing
  plugin (e.g. `conversations`, `web-sdk`) would re-lint all its dependents even when its barrel API
  is unchanged. File-level is as sound and far tighter.

## Lint surface & graph facts (verified)

- ESLint lints `**/*.{ts,tsx}` minus ignores: `node_modules`, `dist`, `.git`, `.check-*`,
  `.claude/worktrees`, `web-core/dist`, `**/*.generated.ts` (`eslint.config.ts:128-138`).
- Path aliases (only two — `tsconfig.json:3-6`): `@plugins/*` → `plugins/*`,
  `@/*` → `plugins/framework/plugins/web-core/web/*`.
- Cross-plugin imports resolve to the runtime **barrel** `plugins/<…>/<runtime>/index.ts`; the
  graph must also include intra-plugin **relative** edges so a deep change reaches a consumer
  through `consumer → barrel → …relative… → deep file`.
- Type-aware rules in force (can fail push): `promise-safety/no-floating-promises`,
  `no-misused-promises`, `switch-exhaustiveness-check`, `await-thenable`
  (`eslint.config.ts:109-118`). `no-unnecessary-condition` is `warn` → suppressed by `--quiet`.
- Only ambient file today: `plugins/framework/plugins/web-core/web/vite-env.d.ts`; no
  `declare global`. So "a changed `.d.ts` → full lint" is a cheap, complete ambient guard.

## Implementation

### 1. New shared CLI module — `plugins/framework/plugins/cli/bin/eslint-affected.ts`

Self-contained (only `fs`/`path` + `Bun.spawn` for git), intra-`cli` sibling like `paths.ts` /
`push-profiler.ts`. Exports:

- `changedFilesVsMain(root): Promise<string[] | null>` — `git merge-base HEAD main` → `git diff
  --name-only <base>` + `git ls-files --others --exclude-standard`; trimmed/deduped relative paths.
  `null` if git fails. (Lift the existing `gitText` helper from `build.ts`.)
- `buildReverseImportGraph(root): Map<string, Set<string>>` — walk all linted `.ts/.tsx`
  (mirror the ignore globs above), extract every `import`/`export … from` and static
  `import("…")` specifier (incl. `import type`), resolve to a repo-relative file path:
  - relative `./`,`../` → try `.ts`, `.tsx`, `/index.ts`, `/index.tsx`;
  - `@plugins/<rest>` → `plugins/<rest>` then barrel/extension resolution;
  - `@/<rest>` → `plugins/framework/plugins/web-core/web/<rest>` likewise.
  Build the **reverse** adjacency map (importee → importers). Adapt the regex extractor that
  already exists (privately) in
  `plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-boundaries/check/index.ts`
  (`extractPluginImports`/`extractRelativeImports`/`resolveImport`) — copy & specialize to
  file-level; it already strips comments and handles all import forms for this codebase.
- `computeAffectedFiles(root): Promise<string[] | null>` — the push policy:
  1. `changed = changedFilesVsMain(root)`; `null` → `null` (caller → full).
  2. **Force-full triggers** (return `null`) if any changed path is: `eslint.config.ts`; under any
     `plugins/**/lint/`; `…/lint/core/lint.generated.ts`; any `tsconfig*.json`; root `package.json`
     or `bun.lock`; or ends in `.d.ts` (ambient).
  3. BFS the reverse graph from the changed `.ts/.tsx` files → affected set (∪ the changed files).
  4. Filter to existing, lintable `.ts/.tsx` (drop deletions, `*.generated.ts`, ignored dirs).
  5. Return the sorted list (possibly `[]` → nothing lint-relevant → skip).

  No file cap: a near-whole-repo set only happens when a near-universally-imported file changed,
  where wide re-linting is *correct*. (Log the set size for visibility.)

### 2. ESLint check — `…/checks/plugins/eslint/check/index.ts`

The check already lints `SINGULARITY_ESLINT_SCOPE` (newline list) using `.cache/eslint-scoped`.
Add **no-cache** support so the affected-set run re-evaluates unchanged dependents (their content
is unchanged, so a content-keyed cache would return stale results — the very gap we're closing):

- When `process.env.SINGULARITY_ESLINT_NO_CACHE === "1"`, omit the `--cache`/`--cache-location`/
  `--cache-strategy` flags (lint the explicit list fresh). Build's scoped run does **not** set this
  flag → unchanged (build stays cached; it's non-authoritative).
- No other change; `bustCacheIfStale` is irrelevant when caching is off.

### 3. Push — `…/cli/bin/commands/push.ts`

After `postRebaseNormalize(...)`, before checks, on **both** paths (worktree `~L481`, `--from-main`
`~L373`):

```ts
const affected = onMain ? null : await computeAffectedFiles(root);
const scopeEnv = affected === null ? undefined : affected.join("\n");
const ok = await runChecksUnderPushSlot(root, profiler, scopeEnv);
```

Thread `scopeEnv` through `runChecksUnderPushSlot` → `runChecksSubprocess`, which builds the child
env: when `scopeEnv !== undefined`, add `SINGULARITY_ESLINT_SCOPE: scopeEnv` **and**
`SINGULARITY_ESLINT_NO_CACHE: "1"`; when `undefined`, set **neither** (→ full `eslint .` via the
existing default — note: full, *not* empty-string which means "skip"). `onMain` short-circuits
`--from-main` to a full lint. Emit a zero-width profiler step `lint-scoped`/`lint-full` and a
`console.log` (`ESLint: N changed → M affected file(s)` vs `ESLint: full repo (<reason>)`) so the
push Gantt shows which path ran.

### 4. Build — `…/cli/bin/commands/build.ts`

Move `gitText` + `computeEslintScope` into the new module (export `computeEslintScope`), import it
back. No behavior change for build.

### Critical files

- `plugins/framework/plugins/cli/bin/eslint-affected.ts` — **new**: git diff, import graph, BFS,
  force-full policy.
- `plugins/framework/plugins/cli/bin/commands/push.ts` — compute affected set, thread env into the
  check subprocess, profiler/log visibility.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/eslint/check/index.ts` — honor
  `SINGULARITY_ESLINT_NO_CACHE`.
- `plugins/framework/plugins/cli/bin/commands/build.ts` — extract `computeEslintScope`/`gitText`.
- Reference (no change): `…/typescript/check/index.ts` (already incremental),
  `…/plugin-boundaries/check/index.ts` (import-extractor to adapt),
  `plugins/infra/plugins/worktree/server/internal/worktree.ts` (cache seeding, unchanged).

## Verification

Run in a scratch worktree, never on `main`. Build first (`./equin build`).

1. **Soundness — the cross-file case (the whole point).** In file A, change a function from sync to
   `async`/Promise-returning; leave an existing unawaited call to it in a **different, unchanged**
   file B. Confirm `computeAffectedFiles` includes B, and a dry `SINGULARITY_ESLINT_SCOPE="<A>\n<B>"
   SINGULARITY_ESLINT_NO_CACHE=1 bun …/cli/bin/index.ts check` **fails** on B's floating promise.
   Then confirm a push of that diff fails (does not reach `main`).
2. **Fast & scoped — narrow change.** One-line edit in a leaf file with no importers → affected set
   is `[thatFile]`; the `checks` step is seconds, `lint-scoped` marker present.
3. **Force-full triggers.** A diff touching `eslint.config.ts` / any `plugins/**/lint/` /
   `tsconfig*.json` / root `package.json` / a `.d.ts` ⇒ `computeAffectedFiles` returns `null`,
   child env has **no** `SINGULARITY_ESLINT_SCOPE`, `eslint .` runs (`lint-full` marker). Plant a
   pre-existing violation in an unrelated file that a rule edit newly flags and confirm push fails.
4. **`--from-main` & main.** `onMain` ⇒ full lint (`lint-full`).
5. **Same-file gate intact.** A floating promise / type error in a *changed* file is still caught
   (in-scope for eslint; tsc always full).
6. **No cache interference.** After a push run, a subsequent `./equin build` scoped run still
   uses `.cache/eslint-scoped` normally (push ran no-cache, wrote nothing).

## Risks / limitations

- **Graph completeness.** Only static `import`/`export … from`/`import("literal")` edges are
  resolved; non-literal dynamic imports aren't — acceptable, since compile-time type dependencies
  are always static. Ambient/global declarations bypass imports → handled by the `.d.ts` force-full
  trigger (today: one file).
- **Cost of the graph build.** Regex-parsing ~2.3k files is ~1–2 s, push-time only, off the hot
  path. Acceptable vs. the 591 s it avoids.
- **Broad changes are still slow — by design.** Touching a near-universally-imported file lints
  most of the repo. That is the correct cost of a wide blast radius; narrow changes (the common
  case) are fast.
- **Build's diff-scope keeps its existing cross-file looseness** — unchanged and acceptable: build
  is not the gate; the next push (now affected-set-sound) is the backstop.
