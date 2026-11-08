# The type check's global hash and npm: a narrower key does not pay

Task: task-1794173048 (responsiveness audit, supervisor task-1793965642-94fdhj),
follow-up of task-1794168950 (research/2026-11-08-global-lint-store-rewrites.md).
Status: **measured, not landed.** The global hash still keys on the whole
lockfile (`tscEngineFp`, `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/shared/tsc-engine.ts`).

## Question

`tscEngineFp` hashes every npm resolution in `bun.lock` (plus the dependency
patches the compiler can see). Any move of it moves every file's result key R:
a whole-tree tsc re-check plus every typed lint part (≈550 worker CPU-s, 11.5 GB
peak per batch process, measured on this branch) in every worktree that
rebases. The follow-up assumed most of those moves are for packages no program
can see — "a package added for one server feature (libpg-query,
node-api-headers)" — so a key over the npm code the program can SEE would
avoid them.

## What was built to answer it

An **npm scope**, prototyped end to end on the branch (all tests green, a
whole-tree `./equin check type-check` passing):

- **Input**: the npm specifiers the repo's files name — `fileImports`, the
  same reading results are keyed on, plus repo `.d.ts` `/// <reference
  types>`; paths aliases and non-package names (`virtual:env`) excluded. Kept
  per file in the walk base and counted per specifier in its root, so an
  incremental walk adjusts the counts by the changed files; a walk test held
  incremental counts equal to a full walk's.
- **Packages**: those names, their `@types/` twins, the tsconfig's `types`, the
  JSX runtime — and what an **environment program** loads: one tsc program
  (built, not checked) whose virtual roots import every specifier from the
  root and, from each workspace, those its `package.json` declares; memoized
  host-wide.
- **Key**: those packages' closure in `bun.lock` (`lockfileNpmClosure`), the
  names it does not hold, and the type-visible patches applied to one of them.
- **A runtime guard**: every program threw when it loaded a `node_modules` file
  of a package outside the scope.

### The guard's finding: the lock's graph is not what tsc loads

The first whole-tree run under a scope built from the lock's dependency graph
alone failed on the guard: the program loaded `type-fest`, which no repo file
imports and no lock entry depends on. `mermaid`'s published
`dist/defaultConfig.d.ts` imports `type-fest`, one of mermaid's
**devDependencies** — absent from its lock entry, yet resolvable because bun's
isolated install keeps a hoisted fallback (`node_modules/.bun/node_modules`,
776 entries) that every package can reach by walking up. So any key over "the
packages the program can see" must ask TypeScript (the environment program),
not the lock; and its memo must also cover the whole lock (what bun hoists
depends on every package installed). A second finding on the way: under the
isolated install a specifier resolves from its file's workspace (95 of 1715
declare dependencies), an ancestor's, or the root — importing everything from
the root missed `mermaid`, a dependency of one plugin workspace only.

## Measurement

`plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/scripts/npm-scope-replay.ts`
replays main's first-parent history: at each commit the old key (whole-lock
resolutions + type-visible patches, as `tscEngineFp`) and the scope's key (each
tree's specifiers through the worker's own `fileImports`, counted per specifier
and updated by the files each commit changed; the environment program's
extra packages measured once on this checkout and applied to every commit).

1444 first-parent commits, 2026-10-09 → 2026-11-08:

| | moves |
| --- | --- |
| whole-lock key (today) | **31** |
| npm scope, as prototyped | 34 |
| npm scope, two naming artifacts removed (projected) | ≈30 |

What differed:

| commit | old | scope | why |
| --- | --- | --- | --- |
| 32871a3027 fix(jobs) | moves | — | a graphile-worker patch (no program loads it) |
| aec983b780 fix(file-watcher) | moves | — | a @parcel/watcher patch (same) |
| 8a5a959c04 feat(closure) | — | moves | first import of `@tailwindcss/node` / `oxide` (genuine) |
| bf4b4fd8d6, c8e33c37b1 | — | moves | first bare import of `child_process`, `module` (artifact: builtins counted as names) |
| ded1588d47, 8fb90a3422 | — | moves | `@browser-host/apps`, `@browser-host-snapshot/apps` (artifact: names an ambient `.d.ts` pattern declares) |

The other 29 moved both keys, legitimately: 14 are `chore(deps)` bumps and
6 more are upgrades in feature commits (zod 4, Vite 8, graphile-worker,
drizzle-kit, …) — all of packages repo files import; the last 9 add or drop a
package some file imports — including the task's own example:
**`libpg-query` is imported by `database/sql-writes`**
(`check/internal/model.ts`), so its addition must move the key;
node-api-headers came in with it.

## Why a global key cannot do better

A global hash can only move for a change no program can see. Nearly every npm
change is to a package some file imports — the upgrade automation moves only
directly declared packages — so it moves every file's key whatever the key's
formula. The prototype would have saved ≈1 whole-tree re-check in four
weeks; landing it costs one whole-tree re-check per host (the formula moves),
and adds load-bearing machinery (walk-base counts, an environment program and
its memo, a guard). Not landed.

## Where the cost actually is

Per file: a bump of package P re-checks every file, not the files whose types
can reach P. Filed as task-1794179791-fk1wl5 (sidequest, manual). Its hard
parts: a package `.d.ts` can augment globals or other modules (every file sees
it); a served `.d.ts` names packages its source never imports (inferred
types); and `@types/node`, `react` and `zod` reach almost every file anyway —
measure what share of the 31 moves touched packages reaching only a minority
of files before designing.

Re-measure with the script (≈30–40 min for four weeks: it reads each tree
through `git show`):

```bash
./equin run plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/scripts/npm-scope-replay.ts --since 2026-10-09
```

The standalone script already excludes the two artifacts (node builtins, and
names HEAD's ambient module patterns match), so its scope count is the
projected one.
