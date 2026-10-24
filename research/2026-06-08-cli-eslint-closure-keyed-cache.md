# Dependency-closure-keyed per-file ESLint cache (Plan 1)

## Context

ESLint's native `--cache` keys each file only on its **own** content, which is
unsound for cross-file type-aware rules: editing an exported type in `A.ts` can
introduce a violation in `B.ts` (which imports `A`) even though `B`'s bytes never
changed. The repo works around this today with a **build-weak / push-strong**
split that is confusing and wasteful:

- `./equin build` lints only the git **diff** (changed files), `--cache`d →
  fast but **unsound** (never checks importers of the changed files).
- `./equin push` lints the **affected set** (changed + transitive importers)
  **FRESH** (no eslint cache, `SINGULARITY_ESLINT_NO_CACHE=1`) → sound but
  re-lints the whole affected set from scratch every push.
- The outer check-cache (`checks/core/cache.ts` + `runner.ts`) keys eslint's
  result on a `cacheSignature()` that folds in scope + a `:fresh`/`:cached`
  suffix, so **a build green can never be reused by push**.

This is why "a passing build check is not a reusable cache entry": build and push
literally run *different-strength* checks over the same tree, keyed apart on
purpose so the weak one can't satisfy the strong gate.

**Goal:** replace eslint's content-`--cache` with a cache keyed on **each file's
content PLUS its transitive import (forward) closure content**, so build and push
both lint the affected set *soundly* and *share* results. A build PASS becomes
reusable by push. The `:fresh` re-lint disappears. As a bonus, the global
content-addressed cache lets a fresh worktree inherit PASSes from sibling
worktrees with identical closures — directly fixing the cold-build full-relint
problem.

This is **Plan 1**: the closure cache, **keeping** the git affected-set as a
candidate-narrowing fast path. A follow-up task
(`task-1780869692586-7cd4ya`) plans the deeper cleanup (dropping git scoping
entirely and collapsing build/push/check onto one path).

## Why a closure fingerprint is the right unit

A file `F`'s type-aware lint result depends on `F` plus everything `F`
transitively imports (type info flows through forward import edges). So:

- "Re-lint everything affected by a change to `A`" (push's reverse-BFS affected
  set) and
- "`F` is stale iff its forward closure contains a changed file"

are **the same set**, expressed two ways. The closure fingerprint turns that set
into a content-addressed key, so the result is shareable across runs/worktrees
instead of being re-derived from a git baseline each time.

## Architectural decision (the crux): where the shared code lives

The import-graph + fingerprint + cache code is needed by **two different
plugins**: the `eslint` check (`tooling/checks/eslint`) and the cli commands
(`cli/bin/{build,push}.ts`). Today `cli/bin/eslint-affected.ts` is **bin-private**
(runtime `null`, not importable cross-plugin) — a check importing from it would
be an illegal `bin → bin` cross-plugin import.

**Decision:** create a new `core/` runtime barrel in the **eslint check plugin**:
`plugins/framework/plugins/tooling/plugins/checks/plugins/eslint/core/`. The
cache *is* the eslint check's data, so it belongs there ("logic belongs with the
data it operates on"). `core/` is a real runtime barrel, so `cli/bin` can import
it as
`@plugins/framework/plugins/tooling/plugins/checks/plugins/eslint/core`
(a legal `plugin.** -> plugin.**` edge, runtime `core`).

The **graph primitives** move into `eslint/core` (one source of truth); the
**git-scoping policy** (`computeAffectedFiles`, `computeEslintScope`,
`changedFilesVsMain`, `isForceFull`, `gitText`) stays in
`cli/bin/eslint-affected.ts` and re-imports the primitives from `eslint/core`.

## Files

### New — `checks/plugins/eslint/core/`

- **`index.ts`** (barrel) — re-exports `buildImportGraphs`, `ImportGraphs`,
  `computeClosureFingerprints`, `globalConfigFingerprint`, the
  `openEslintClosureCache` cache, and the moved primitives (`findLintFiles`,
  `isLintable`, `resolveSpecifier`, `buildReverseImportGraph`) for
  `eslint-affected.ts` to reuse.

- **`import-graph.ts`** — move verbatim from `eslint-affected.ts:88-296`:
  `stripComments`, `extractImportSpecifiers`, `resolveSpecifier`, `safeRead`,
  `isIgnoredRelPath`, `isLintable`, `walkLintFiles`, `findLintFiles`,
  `buildReverseImportGraph`, and the `IGNORED_DIR_NAMES` / `WEB_CORE_WEB`
  constants. Add:
  ```ts
  export interface ImportGraphs {
    files: string[];                    // all lintable rel paths
    forward: Map<string, Set<string>>;  // importer -> Set<importee>
    reverse: Map<string, Set<string>>;  // importee -> Set<importer>
  }
  // single walk over findLintFiles(root); for each resolved importer->importee
  // edge, insert into BOTH maps.
  export function buildImportGraphs(root: string): ImportGraphs;
  ```
  Keep `buildReverseImportGraph` as a thin wrapper returning `.reverse`
  (back-compat for `computeAffectedFiles`).

- **`fingerprint.ts`**
  ```ts
  export interface FingerprintResult {
    global: string;                 // globalConfigFingerprint(root)
    perFile: Map<string, string>;   // relpath -> closureFingerprint
  }
  export function globalConfigFingerprint(root: string): string;
  export function computeClosureFingerprints(
    root: string, graphs: ImportGraphs, candidates: string[],
  ): FingerprintResult;
  ```
  Internal: memoized DFS over `graphs.forward` for each candidate's transitive
  forward closure (visited-set for cycles — a content hash over the *unordered
  set* of `(path, hash)` is cycle-safe). Memoize `ch(rel) = sha256(content)` per
  file.

- **`closure-cache.ts`** — mirror `checks/core/cache.ts` (its `prune`,
  `MAX_AGE_MS`/`MAX_ENTRIES`/`TRIM_TO`, atomic write-then-rename). Import
  `SINGULARITY_DIR` from **`@plugins/infra/plugins/paths/core`** (same as
  `cache.ts:12`). `CACHE_DIR = join(SINGULARITY_DIR, "eslint-closure-cache")`.
  ```ts
  export interface EslintClosureCache {
    has(relPath: string, fingerprint: string): boolean;  // PASS recorded?
    record(relPath: string, fingerprint: string): void;  // atomic
  }
  export function openEslintClosureCache(): EslintClosureCache;
  ```
  Entry filename `sha256(`${relPath}:${fingerprint}`) + ".json"` — no
  checkId/treeHash; the fingerprint already subsumes tree + config state.

### Modify

- **`cli/bin/eslint-affected.ts`** — delete the moved primitives (lines
  ~77-296); import them from
  `@plugins/framework/plugins/tooling/plugins/checks/plugins/eslint/core`. Keep
  `gitText`, `changedFilesVsMain`, `computeEslintScope`, `isForceFull`,
  `computeAffectedFiles` (the latter now calls `buildImportGraphs(root).reverse`).

- **`checks/plugins/eslint/check/index.ts`** — rewrite `run()` (see below);
  simplify `cacheSignature()`; delete `bustCacheIfStale`, `newestMtimeMs`,
  `findPluginLintDirs` (superseded by `globalConfigFingerprint`); drop all
  `--cache`/`--cache-location`/`--cache-strategy`/`eslint-scoped` logic and the
  `SINGULARITY_ESLINT_NO_CACHE` read.

- **`cli/bin/commands/build.ts:8,763`** — switch `computeEslintScope` →
  `computeAffectedFiles` so build lints the same **sound** affected set push
  does. Comment the cold-first-build tradeoff (mitigated by the global cache).

- **`cli/bin/commands/push.ts:~60`** — remove
  `env.SINGULARITY_ESLINT_NO_CACHE = "1"`; update the stale "FRESH / no content
  cache" comments (lines ~41-48, 125-129).

## Fingerprint formulation (precise)

- `ch(rel) = sha256(safeRead(join(root, rel)) ?? "")`
- **Global config component** `globalConfigFingerprint(root)` = sha256 over the
  sorted `"<rel>\0<ch(rel)>"` of every file matching the **`isForceFull` trigger
  list** (reuse as the single source of truth): `eslint.config.ts`, every file
  under any `plugins/**/lint/**`, every `tsconfig*.json`, `package.json`,
  `bun.lock`/`bun.lockb`, every `*.d.ts`, every `*.lint.generated.ts`.
- **Closure fingerprint** for file `f`:
  ```
  closure(f) = { f } ∪ transitive forward-closure of f over graphs.forward
  fp(f) = sha256(
    "g:" + globalConfigFingerprint(root) + "\n" +
    sorted( `${c}\0${ch(c)}` for c in closure(f) ).join("\n")
  )
  ```

Properties: editing a type in `A` changes `ch(A)` → changes `fp(B)` for every `B`
whose closure contains `A` → `B` re-lints (**the soundness fix**). A config/rule
change flips the global component → every `fp` changes → whole cache invalidated
(**replaces `bustCacheIfStale`**; `isForceFull` becomes a pure perf fast-path).
Content-addressed + global dir → fresh worktrees inherit sibling PASSes (**cold-
build fix**).

## `run()` rewrite

```ts
async run() {
  const root = await getRoot();
  const scope = eslintScope();              // env list | null (unchanged parser)
  if (scope !== null && scope.length === 0) return { ok: true };

  const graphs = buildImportGraphs(root);
  const candidates = scope ?? graphs.files; // affected set, or ALL lintable files
  const { perFile } = computeClosureFingerprints(root, graphs, candidates);

  const cache = openEslintClosureCache();
  const toLint = candidates.filter((f) => {
    const fp = perFile.get(f);
    return !fp || !cache.has(f, fp);        // unreadable fp => lint to be safe
  });
  if (toLint.length === 0) return { ok: true };

  const proc = Bun.spawn(
    [process.execPath, "x", "eslint", ...toLint, "--quiet"],  // NO native --cache
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([/* ... */]);

  if (exitCode === 0) {
    for (const f of toLint) {
      const fp = perFile.get(f);
      if (fp) cache.record(f, fp);          // record PASS per linted file
    }
    return { ok: true };
  }
  // failure: report as today; record NOTHING (batch exit can't attribute
  // per-file → safest is record none; conservative, never a false PASS).
  return { ok: false, message: /* ... */, hint: /* ... */ };
}
```

## `cacheSignature()` simplification

```ts
cacheSignature() {
  const scope = eslintScope();
  if (scope === null) return "scope=full";
  if (scope.length === 0) return "scope=empty";
  return `scope=list:${sha256([...scope].sort().join("\n"))}`;
}
```

**Why build & push now share the outer check-cache entry:** at an identical
tree-hash (`computeTreeHash` is content-only `git write-tree`), both build and
push derive scope from `computeAffectedFiles(root)` = `merge-base HEAD main` →
diff+untracked → reverse-BFS → **identical sorted list** → identical
`scope=list:<hash>` → identical outer key. With the `:fresh` suffix gone, a build
PASS at tree T is reused by push at tree T. (Both gate scope on the same "not
main" condition and both fall to `scope=full` on force-full, so the full/scoped
decision matches too.)

## Known soundness limitations (call out)

1. **Regex import extraction can miss edges** (unusual re-export syntax,
   non-literal `import(expr)`, triple-slash refs). A missed edge → a dependent's
   closure omits a file → a stale PASS. **This is the SAME risk push already
   carries** (its affected set uses the same extractor) — no regression. The
   `*.d.ts` global-component trigger covers the ambient-declaration escape hatch.
2. **Batch-failure under-recording:** a clean file batched with a dirty one
   doesn't get its PASS recorded (eslint exits non-zero on the whole batch).
   Conservative — never unsound — at the cost of re-linting the batch next time.

## Verification

1. **Build→push shares the outer cache.** On a branch, make a typed change →
   `./equin build` (eslint shows `ok`, `~/.singularity/eslint-closure-cache/`
   gains entries). Without touching the tree → `./equin push`; the spawned
   `check` subprocess logs `eslint ... ok (cached)`. Temporarily log
   `cacheSignature()` in both and assert byte-identical.
2. **Cross-file violation still caught (core test).** `A.ts` exports a type used
   by `B.ts`; both PASS (recorded). Edit `A.ts` so the type now triggers a rule
   in `B.ts` (B's bytes unchanged) → check FAILS, with `B` present in a debug log
   of `toLint`. (Today's content-`--cache` build would falsely pass B.)
3. **Cold sibling inheritance.** Build W1 (populates global cache); create sibling
   W2 at the same commit; `./equin build` in W2 → `toLint` empty/near-empty.
4. **Config invalidation.** With a warm cache, touch `eslint.config.ts` → whole
   cache invalid (every `fp` changes) → non-trivial `toLint`, replacing
   `bustCacheIfStale`.

## Vestigial after this / handoff to cleanup task

Deleted in Plan 1: `bustCacheIfStale` + `newestMtimeMs` + `findPluginLintDirs`,
`SINGULARITY_ESLINT_NO_CACHE`, the `:fresh`/`:cached` distinction. `computeEslintScope`
loses its only caller (build) — delete it here or flag for the cleanup task.

**Plan 2 (task `task-1780869692586-7cd4ya`) — do NOT touch now:** the whole
git-scoping layer (`SINGULARITY_ESLINT_SCOPE` plumbing, `computeAffectedFiles`,
`changedFilesVsMain`, `isForceFull`, the build/push/check three-path split). Once
the closure cache makes a *full* candidate set cheap (all hits except changed
closures), git scoping is just a perf narrowing that can be dropped in favor of
pure fingerprint-diffing over `graphs.files`, collapsing all three onto one path.
The graph primitives in `eslint/core` survive; the git-diff scoping does not.

## Critical files

- `plugins/framework/plugins/tooling/plugins/checks/plugins/eslint/check/index.ts`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/eslint/core/` *(new)*
- `plugins/framework/plugins/cli/bin/eslint-affected.ts`
- `plugins/framework/plugins/tooling/plugins/checks/core/cache.ts` *(mirror)*
- `plugins/framework/plugins/cli/bin/commands/build.ts` *(line 8, 763)*
- `plugins/framework/plugins/cli/bin/commands/push.ts` *(line ~60)*
