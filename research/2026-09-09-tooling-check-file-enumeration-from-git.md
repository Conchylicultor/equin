# A check's file universe comes from git, not from a filesystem walk

## Context

`./equin push` from `att-1788884187-ak4l` failed on 2026-09-09 with:

```
type-check: 14 lintable file(s) belong to no tsconfig program:
  .cache/scratch/…
```

The agent had left exploratory `.ts` scripts in `.cache/scratch/`. `.cache/` is
gitignored — and is the directory type-check itself writes its `.tsbuildinfo`
into (`checks/core/discover.ts:79`). Those files are not repo source by any
definition, yet type-check claimed they were lintable, found no tsconfig that
owns them, and failed the build. The hint told the agent to add the directory to
a tsconfig `include`, which is the wrong fix.

### Root cause

**Two enumerations of "the repo's files" that disagree, and the disagreement is
exactly the gitignored set.**

Everything else in the check system derives that set from git:

- the cache key — `computeTreeHash` (`checks/core/tree-hash.ts`) builds a scratch
  index, runs `git add -A` + `write-tree`. That is tracked + untracked-not-ignored.
- the read-set snapshot — `checks/core/read-set.ts` loads one `git ls-tree -r`
  over that same tree.
- ~14 other checks — each hand-rolls a `git ls-files` pair
  (`test-layout/check/index.ts:190`, `layout-harness/check/index.ts:112`,
  `tailwind-scan-covers-classes/check/index.ts:130`, …).

type-check does not. It walks the filesystem twice with a hand-maintained
deny-list:

- `type-check/check/import-graph.ts` — `walkLintFiles` / `findLintFiles`, skipping
  `node_modules`, `dist`, `.git`, `.check-*`, `.claude/worktrees/`, `*.generated.ts`.
- `type-check/check/fingerprint.ts` — `walkGlobalTriggers`, a second copy of the
  same list.

So the verdict is **not a function of the tree the cache keys on**. This is the
same class of bug `checks/core/scan-context.ts` already documents having fixed
once for `grepCode` — there the scanner saw *less* than the cache key (missing
untracked files); here it sees *more*.

The divergence is visible inside this one check: type-check is `inputKeyed`, and
`check/outer-read-set.ts` records membership as `view.glob("*.ts")` over the git
**tree snapshot**, while `graphs.files` comes from the **filesystem walk**. Two
answers to "which `.ts` files exist", in adjacent lines.

### Other live symptoms of the same cause

- `walkGlobalTriggers` skips a literal `dist` segment but not `dist.staging.*` /
  `dist.live.*` / `dist.old.*` (all gitignored). A `package.json` or `.d.ts` under
  one perturbs `globalConfigFingerprint` → the whole closure cache invalidates for
  a reason that never lands on main.
- `import-graph.ts:17-20` claims to mirror `eslint.config.ts`'s ignores exactly.
  It has already drifted: the real list
  (`tooling/plugins/lint/core/build-lint-config.ts:349`) also carries
  `prototypes/**` and `plugins/framework/plugins/web-core/dist/**`.
- `plugin-boundaries/check/index.ts:441` has the identical walk shape
  (`IGNORED_DIRS = {node_modules, dist, .git}`) and is **also `inputKeyed`**, with
  its membership fact recorded as `view.glob("plugins/**")` off the same git
  snapshot (`plugin-boundaries/check/read-set.ts:63`). A stray `.ts` under a
  gitignored dir inside `plugins/` reproduces the bug there too.

### Intended outcome

A check's file universe is the git-derived set the cache key already represents.
There is no second list to keep in sync, because there is no second enumeration.

---

## Design

### One git-backed lister, one call per run

New `plugins/framework/plugins/tooling/plugins/checks/core/repo-files.ts`:

```ts
/**
 * Every repo-relevant path: tracked + untracked-not-ignored, minus index
 * entries whose file is gone from the worktree. Exactly the membership
 * `computeTreeHash`'s `git add -A` + `write-tree` folds into the check cache
 * key — so a check that enumerates through this can never record a verdict
 * about content the key does not cover.
 *
 * Throws on git failure. NEVER returns [] — an absorbed failure here would
 * silently tell every caller the repo is empty and turn each file rule into a
 * vacuous pass.
 */
export async function listRepoFiles(root: string): Promise<string[]>;
```

Implementation: `git ls-files -z --cached --others --exclude-standard`, minus
`git ls-files -z --deleted` (see the hazard below), deduped and sorted. Use
`spawnCaptured` from `@plugins/infra/plugins/spawn/core` with a wedge-breaker
timeout, and throw with the exit code + stderr on failure — the shape
`test-layout/check/index.ts:196` already uses, and whose comment already states
the "never `[]`" rationale. Export it from `checks/core/index.ts`.

### The enumeration happens once, at the top of `run()`

Rather than making `findLintFiles` async and leaving two enumerators in place,
**delete both walks** and thread one list down. `import-graph.ts` and
`fingerprint.ts` stop touching the filesystem for enumeration entirely, keep
owning their own predicates, and stay synchronous:

| file | before | after |
| --- | --- | --- |
| `import-graph.ts` | `findLintFiles(root)` walks | `buildImportGraphs(root, allFiles)` filters `allFiles` through the existing `isLintable` |
| `fingerprint.ts` | `walkGlobalTriggers` walks | `findGlobalTriggerFiles(root, allFiles)` filters through the existing `isGlobalTrigger`; `globalConfigFingerprint` / `computeClosureFingerprints` take `allFiles` and thread it |
| `outer-read-set.ts` | — | `recordOuterReadSet(view, root, graphs, allFiles)` |
| `check/index.ts` `run()` | — | `const allFiles = await listRepoFiles(root);` immediately after `discoverTscTargets`, then passed to all three |

Delete `walkLintFiles`, `findLintFiles`, `walkGlobalTriggers` and **both** copies
of `IGNORED_DIR_NAMES`. Reduce `isIgnoredRelPath` to the two rules git does not
already give for free: `*.generated.ts`, and `prototypes/**` (the one live drift
from eslint's ignores — `prototypes/` is tracked, so git will list it).

This is the rung-1 form of the fix: with a single caller of a single lister,
"two enumerations disagree" has no spelling left. It also removes the async
ripple — the five downstream functions are CPU-bound over the supplied list, so
they stay sync and stay unit-testable from a plain `string[]`.

The lister returns **everything, unfiltered**. `fingerprint.ts`'s predicate is
disjoint from `import-graph.ts`'s (`package.json`, `bun.lock`, `tsconfig*.json`
are not `.ts`), so pathspec-scoping the lister would force a second git call. One
unscoped call, two in-memory filters.

### Then the same treatment for `plugin-boundaries`

`plugin-boundaries/check/index.ts`'s `findSourceFiles` / `walkSourceFiles` is the
same walk with the same private deny-list, and it is `inputKeyed` — so it carries
the same "PASS recorded for content the key does not cover" exposure. Replace the
walk with `listRepoFiles` + its existing `SOURCE_ROOTS` prefix filter. Small diff,
same helper, and it stops the bug report's own repro from simply relocating to a
different check.

Leave `tooling/plugins/boundaries/core/check.ts`'s `walkSourceFiles` for a
follow-up: it is not `inputKeyed`, so its exposure is bounded by the whole-tree
key and self-heals on the next tree change.

---

## Hazard: index entries for deleted files

`git ls-files --cached` lists index entries, including files deleted from the
worktree. `computeTreeHash`'s `add -A` drops those; the old filesystem walk never
saw them. If they leak into `graphs.files`, `computeOwnership` (which builds from
tsconfig `fileNames`, read off disk) will not own them — and the coverage gate
fails on a file the user just deleted. This is the one way the change could
introduce a *new* false failure, so subtract `git ls-files --deleted` in the
lister and say why in a comment.

## What is deliberately not lost

- **No file that must be linted becomes invisible.** The only gitignored `.ts`
  outside `node_modules` on main are six `*.composition.*.generated.ts`, which
  `isLintable` already excludes via its `.generated.ts` rule. No tsconfig
  `include` in the repo points at a gitignored path.
- **The coverage gate keeps its teeth.** A brand-new, uncommitted `.ts` is
  untracked-not-ignored, so `--others --exclude-standard` still lists it and the
  gate still fires. That is the case the raw walk existed for, and git covers it.
- **The read-set's H3 membership guard gets *stronger*.** Its fact
  (`view.glob("*.ts")`) is already snapshot-derived; after this change
  `graphs.files` derives from the same git-honoring set, so the recorded fact and
  the scanned set agree by construction instead of by coincidence.
- **tsc coverage is untouched.** The workers run `tsc -p <target>` off disk; the
  file list only drives lint assignment and the coverage gate.

## Also worth doing

Reword the gate's `hint`. Once the universe is git-derived an uncovered file is
genuinely repo source, so "add its directory to a tsconfig `include`" is right —
but name the second remedy too: if it is not source, it does not belong in the
git tree.

---

## Files to modify

- **new** `plugins/framework/plugins/tooling/plugins/checks/core/repo-files.ts` — `listRepoFiles`
- `plugins/framework/plugins/tooling/plugins/checks/core/index.ts` — barrel export
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/import-graph.ts`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/fingerprint.ts`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/index.ts`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/outer-read-set.ts`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/outer-read-set.test.ts` — `record()` is already async; add the `listRepoFiles` call and thread `allFiles`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-boundaries/check/index.ts` — same swap
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/CLAUDE.md` — the enumeration is git-derived; say so where the walk was described

## Follow-ups to file as tasks, not to build here

1. **A guardrail (rung 3).** A lint rule banning a recursive `readdirSync`
   enumeration inside `checks/plugins/*/check/**` and `boundaries/**`, pointing at
   `listRepoFiles` — modelled on the existing `no-adhoc-git-grep` rule that keeps
   raw `git grep` inside `grepCode`. It can only go green after
   `boundaries/core/check.ts` is migrated too, so it belongs with that migration.
2. **One source for the lint ignores.** Hoist `build-lint-config.ts`'s inline
   `ignores` to a named export and have `isIgnoredRelPath` derive from it, so
   `import-graph.ts`'s "mirrors eslint exactly" comment is true by construction
   rather than by discipline. (The import direction is already precedented —
   `type-check/shared/worker.ts:22` imports from `tooling/plugins/lint/core`.)
3. **A sanctioned home for exploratory scripts.** The report notes that a script
   importing repo code has nowhere to live: the session scratchpad is outside the
   repo, so `@plugins/*` and `typescript` do not resolve. After this fix a `.ts`
   under `.cache/` no longer breaks the build, but that is an accident rather than
   a decision. Worth settling separately.

## Verification

1. `./equin check type-check` — passes on a clean worktree.
2. **Repro the bug, confirm it is gone:** `mkdir -p .cache/scratch && echo 'export const x: number = 1;' > .cache/scratch/probe.ts`, then `./equin check type-check`. Before: fails with "belong to no tsconfig program". After: passes. Repeat with the file under `plugins/` (e.g. `plugins/.cache/probe.ts`) and run `./equin check plugin-boundaries`.
3. **Confirm the gate still has teeth:** create a *tracked-eligible* stray, `echo 'export const y = 1;' > stray-probe.ts` at the repo root (untracked, not ignored). `./equin check type-check` must FAIL naming it. Delete it.
4. **Confirm the deleted-file hazard is handled:** `git rm --cached` a `.ts` file's worktree copy (`rm <file>` without staging the deletion), run `./equin check type-check` — must not report it as uncovered. Restore.
5. `./equin test plugins/framework/plugins/tooling/plugins/checks` — the `outer-read-set` and `plugin-boundaries/read-set` suites.
6. **Confirm the fingerprint no longer moves with build artifacts:** run `./equin check type-check` twice with a `./equin build` in between and check `check-type-check.log` reports a cache HIT rather than a full closure invalidation.
7. `./equin build` (background), then `./equin check` for the full pass.
