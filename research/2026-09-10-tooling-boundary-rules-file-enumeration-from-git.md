# boundary-rules: the file set comes from git, not a directory deny-list

## Context

`research/2026-09-09-tooling-check-file-enumeration-from-git.md` moved `type-check`
and `plugin-boundaries` off hand-rolled `readdirSync` walks onto `listRepoFiles`
(tracked + untracked-not-ignored — the same universe `computeTreeHash` keys the
check cache on). It deliberately left one walk behind:
`tooling/plugins/boundaries/core/check.ts` (the `boundary-rules` check), which
still stays on the `no-adhoc-repo-walk` lint allowlist as a "known instance".

State of the request versus the tree today:

- **`plugin-boundaries/check/index.ts` is already converted** (cbf79336e). It
  calls `listRepoFiles` once per run and selects from it
  (`check/source-files.ts`, `check/repo-tree.ts`). Its allowlist entry is
  already gone. Nothing to do there.
- **`boundary-rules` is not `inputKeyed`.** It is on the legacy whole-tree slot
  (`scope` default `"tree"`, no `cacheSignature`), so a PASS is keyed on the
  full tree hash. Its exposure is "a verdict that depends on gitignored content
  the key does not cover". That is not the read-set replay hazard.
- **Its `run()` is already async.** The sync walk is only called from inside
  `run()`, so swapping in the async `listRepoFiles` changes no signature.

### What the deny-list actually got wrong

`IGNORED_DIRS = {node_modules, dist, build, .git}` gets it wrong in both
directions:

1. **It hides real, tracked source.** `build` is not build output in this repo.
   It is the name of three plugins. 174 tracked files sit under a `build/`
   segment: `plugins/build/` (146 files), `plugins/framework/plugins/cli/plugins/build/`
   (16) and `plugins/debug/plugins/profiling/plugins/build/` (12). None of them
   has ever been checked for runtime isolation or zone edges.
2. **It sees gitignored content.** Examples are `.cache/`, `dist.*`,
   `test-results/`, and a gitignored composition registry. A `.ts` file left
   there is scanned even though no commit contains it and the cache key does
   not cover it.

`SOURCE_ROOTS = ["plugins", "web/src", "cli/src"]` is also stale. The last two
directories do not exist. Even if they did, `zoneMap.resolveFile` would return
null for them, because the only zone is `zone("plugin", { match: "plugins" })`.

## Design

**Scope comes from the zone config, and membership comes from git. Nothing
else decides either.**

- `run()` calls `listRepoFiles(root)` once, keeps `.ts`/`.tsx`, and hands each
  path to the existing `zoneMap.resolveFile`. The loop already did that, and it
  already skips files outside every zone.
- `SOURCE_ROOTS`, `IGNORED_DIRS`, `findSourceFiles` and `walkSourceFiles` are
  deleted. A second statement of "which directories count" alongside the zone
  `match` could only drift from it, and that is how `web/src` / `cli/src`
  outlived their directories. With it gone, the scope is set by the zones alone.
- `safeRead` narrows to the same errno set `plugin-boundaries` uses
  (`ENOENT`/`EACCES`/`ENOTDIR` means skip; anything else throws). Every path is
  now git-listed and present, so a read failure is a race with a delete. Any
  other errno is a real fault and should be loud. The old `code == null` guard
  swallowed every errno.
- **Location stays `boundaries/core/check.ts`.** The new edge
  `boundaries/core → checks/core` is legal: the `core: ["core"]` runtime row
  allows it, and `plugin.** -> plugin.**` allows the zone edge. It also creates
  no cycle, because `checks/core` imports nothing from `boundaries`. Its only
  mention is the dynamic `import()` in the excluded `check.generated.ts`.
  Moving the check body into `boundaries/check/` would be tidier, since the
  core barrel would stop exporting a `Check`. But it is orthogonal to this
  change, so it stays out of scope.
- **`boundary-rules` stays off `inputKeyed`.** Adopting read-set replay is a
  cache-performance change with its own completeness proof, and it was not
  requested. After this change the scanned set equals the key's universe, which
  is exactly the soundness the whole-tree slot needs.

### Guardrail

`no-adhoc-repo-walk` already bans the deny-list shape. Removing the
`boundaries/core/check.ts` allowlist entry is the enforcement step. After
that, re-adding such a list anywhere under the check system fails lint (rung 3).
The one remaining non-bounded-walk entry is the already-run migration script
`checks/core/scripts/fix-shared-to-relative.ts`. It gets its own comment heading
rather than sitting under the "known instance of the bug" heading, which no
longer applies to anything.

## Files

- `plugins/framework/plugins/tooling/plugins/boundaries/core/check.ts`: swap
  the walk for `listRepoFiles` and delete the roots and the deny-list.
- `plugins/framework/plugins/tooling/plugins/lint/plugins/repo-walk-safety/lint/index.ts`:
  drop the entry and re-head the migration-script comment.
- `plugins/framework/plugins/tooling/plugins/lint/plugins/repo-walk-safety/CLAUDE.md`:
  the allowlist now holds bounded walks plus one dead script.
- `plugins/framework/plugins/tooling/plugins/boundaries/CLAUDE.md`: short
  "the file set comes from git; the zones decide scope" note, including the
  `build/` finding.

## Risk

The three `build` plugins are scanned for the first time. If they hold real
runtime-isolation or zone violations, the check goes red. Those are real
violations, to fix at the import. They do not get a new exception.
`plugin-boundaries` (already git-based) and the `runtime-isolation` lint rule
already see those files, so they are probably clean.

## Verification

1. `./equin check boundary-rules`: green on the clean worktree.
2. Probe, gitignored side: write `plugins/build/.cache/probe.ts` (and a
   `dist.x/` variant) with a `core → web` cross-plugin import. The old walk
   would scan it and fail. The new check passes, because git does not list it.
3. Probe, tracked-`build/` side: write an untracked-not-ignored
   `plugins/build/core/probe.ts` with a `core → web` cross-plugin import. The
   old walk skipped the directory. The new check fails with a runtime-isolation
   violation. Delete both probes afterwards.
4. `./equin check eslint` (or `type-check`): `no-adhoc-repo-walk` stays
   green with the entry removed.
5. `./equin build`.
