# Every checkout is installed before anything runs in it

## Context

A fresh agent worktree's PreToolUse guard failed to load:
`Cannot find package '@noble/hashes'` from `packages/string-hash/core/internal/sha256.ts`
(reached through the `claude-cli/accounts` guard). The bootstrap fell back to
main's guard, so nothing went unguarded, but the worktree's own guards never ran
until its first `./equin` call, and every tool call carried the fallback notice.

Root cause: **a worktree has no `node_modules` until its first `./equin` command**
(`ensureDeps()` in `framework/cli/plugins/bootstrap/cli/ensure-deps.ts` runs lazily
from `bin/index.ts`). The guard hook runs plain `bun …/guards/bin/guard.ts`, never
`./equin`, so it is the first program to run uninstalled. Bun resolves a package by
walking up from the importing file. Worktrees live under main's `.claude/worktrees/`,
so the walk escapes into **main's root** `node_modules`. That folder holds only root
dependencies: `zod` resolved by luck, while string-hash's own `@noble/hashes` (installed
in main's `plugins/…/string-hash/node_modules`) did not.

The first fix (bad85cd98f) hoisted `@noble/hashes` to the root `package.json` and added
`guards:closure-root-deps-only`. That broke dependency ownership and made the escape
into main's packages the contract. **It is reverted in this change.**

### The model

1. A checkout is one unit: its source plus its own install, from its own `bun.lock`.
2. Each plugin declares its own direct npm dependencies. Resolution is per file, so
   cross-plugin use needs no declaration.
3. **A checkout is installed before anything runs in it.** Installing is part of
   creating the checkout, not a side effect of its first `./equin` call.
4. **A lookup that leaves the checkout is a bug.** A checkout found uninstalled says
   so by name; it never quietly borrows main's packages.

## Design

### 1. The checkout installs itself, at creation

The new checkout runs **its own** CLI: `<path>/equin install`. The bootstrap already
runs `ensureDeps()` unconditionally for every argv (`bin/index.ts:16`), so the verb's
body only reports the outcome. This reuses the one install chokepoint (stamp,
`.install.lock`, freshness skip, attributed failures) instead of moving `ensureDeps`
across the boundary table. `server` may not import `cli`, and `ensureDeps` is
deliberately a cli/bootstrap module. It also installs with the checkout's own
version of the install code and its own lock.

- **New verb** `install` in `framework/cli/plugins/bootstrap` (or a sibling
  `cli/plugins/install`), declared with `defineCliCommand`. It passes
  `frozenLockfile: true` so creation never rewrites `bun.lock`: a lock that does not
  match its `package.json` is a loud failure at creation, not a silent edit.
  `ensureDeps` already takes `frozenLockfile`. The bootstrap's own unconditional
  `ensureDeps()` must not run a non-frozen install first, so the verb is either
  recognised before the bootstrap call (preferred: the bootstrap reads nothing of
  argv today, so check `cli:bootstrap-*` before adding this), or the verb is defined
  as "a non-frozen install, then report". Decide at implementation, after reading
  the bootstrap's argv rule.
- **The spare pool installs.** `createSpareIn` (`infra/worktree/server/internal/spare.ts`)
  runs the install after `add --detach` and **before** `lockWorktree`. The lock reason
  is the readiness marker, so a ready spare is now an installed spare, and a failed
  install leaves an unlocked spare that the prune reclaims (existing path). The cost
  stays off the launch path; `SPARE_TARGET` is 1.
- **Every checkout path in `setupWorktree`** (`infra/worktree/server/internal/worktree.ts:808`)
  runs the install after the checkout settles: fresh `add`, claimed spare (its branch
  switch may move `bun.lock`, which costs ~1.4 s with a frozen install, or ~140 ms
  when fresh), and `existing` (`convergeExistingCheckout`, which covers checkouts
  made before this change). A failure throws, so the launch fails loudly with
  install's own output.
- **Spawned through `infra/spawn`** with `backgroundArgv` (spawn-priority), output
  captured into the thrown error. It runs inside the `worktree-mutate` slot for spares
  (already held) and outside it for the claim path (the slot serialises git
  mutations; the install is guarded by the checkout's own `.install.lock`).

### 2. An uninstalled checkout says so

`guards/bin/bootstrap.ts` (node builtins only) checks the install stamp
`<checkout>/node_modules/.equin-deps` before `import("./hook")`. When it is absent,
it treats the load as failed with a named reason: *"this checkout is not installed
(no node_modules/.equin-deps) — run any ./equin command"*. The existing main-guard
fallback still applies, so a checkout is never locked out. This replaces a cryptic
`Cannot find package` and also stops the half-loaded case, where a guard runs on
main's copy of a root package such as `zod`.

- The bootstrap cannot import `STAMP_REL`. It keeps a literal, and
  `bootstrap.test.ts` asserts it equals `ensure-deps`'s exported `STAMP_REL` (tests
  may import it), so the two cannot drift.
- `stop-guard.ts` statically imports `infra/worktree/server` and is fail-open by
  contract. It gets the same presence check: exit 0 with the reason on stderr.
- Presence only, not staleness. A stale-but-own install is still the checkout's own
  (rule 1 holds), and `./equin build` refreshes it. A per-call signature walk
  (~140 ms) is not worth it on every tool call.

### 3. Revert

Restore `@noble/hashes` to `packages/string-hash/package.json`, drop it from the root
`package.json` and `bun.lock`, and delete `guards:closure-root-deps-only` and its
CLAUDE.md paragraph (already done in the working tree).

## Files

- `plugins/framework/plugins/cli/plugins/bootstrap/cli/` (or a new `cli/plugins/install/cli/`): the `install` verb.
- `plugins/framework/plugins/cli/bin/index.ts`: only if the frozen arm needs an argv peek.
- `plugins/infra/plugins/worktree/server/internal/spare.ts`, `worktree.ts`: call the install. Add one helper, `installCheckout(path, signal)`, in `server/internal/`, shared by both.
- `plugins/framework/plugins/tooling/plugins/guards/bin/bootstrap.ts`, `stop-guard.ts`, `bootstrap.test.ts`: the stamp check.
- `plugins/infra/plugins/worktree/CLAUDE.md` (spare readiness now means installed), `guards/CLAUDE.md` ("The guard survives a broken checkout": now also an uninstalled one), `cli/CLAUDE.md` (the verb).

## Open points

- **Disk:** each worktree is ~1.3 GB apparent (`du`). With bun's default hoisted
  layout and APFS clonefile, the real cost should be far lower. Measure real usage
  of one spare (`df` before and after) at implementation. Installing changes no
  steady state, since every worktree is installed at its first build anyway; only
  the spare is new.
- **Nested-under-main** is what makes rule 4's escape possible at all. Moving worktrees
  out of main's folder would make the escape impossible, but it is a much larger move
  (gateway, Claude Code's `.claude/worktrees` convention) and is out of scope. The
  stamp check makes the escape loud instead.

## Verification

- `./equin test plugins/framework/plugins/tooling/plugins/guards plugins/infra/plugins/worktree plugins/framework/plugins/cli/plugins/bootstrap`.
- Bootstrap: run `guard.ts` against a temp checkout without `node_modules`; expect
  the fallback with the "not installed" reason, never `Cannot find package`.
- `./equin install` in a checkout with `node_modules` removed: installs, writes the
  stamp, and exits 0. A second run is the ~140 ms fresh path.
- Spare pool: run the refill job on this worktree's build. The new spare has
  `node_modules/.equin-deps` before it is locked.
- After push: the next launched conversation's first tool call carries no
  guard-fallback notice.

## Implementation notes

- **The frozen arm is env, not argv.** The bootstrap reads no argv on purpose
  (`bin/index.ts`, the orphan guard's comment): it runs before the install, so it
  cannot load the declarations that say what a verb means, and a hardcoded
  `argv[2] === "install"` would be the second copy of a command list it was
  rid of. What IS knowable pre-install is env set by the spawner — the
  `BUILD_DETACHED` precedent. So `infra/worktree` sets `EQUIN_FROZEN_LOCKFILE=1`
  (a withheld, new-name-only key in `env-names`), and the bootstrap passes
  `frozenLockfile: readEnv("FROZEN_LOCKFILE") === "1"` to its one `ensureDeps`
  call. The `install` verb (`framework/cli/plugins/install`) is then a named
  no-op: its body confirms the stamp the bootstrap wrote. A hand-typed
  `./equin install` is not frozen unless the env says so.
- `STAMP_REL` is exported from the bootstrap barrel (the `install` verb reads
  it too, so it is not a test-only name); `guards/bin/bootstrap.test.ts`
  asserts the bootstrap's `INSTALL_STAMP_REL` literal equals it.
- `createSpareIn(repoRoot, install, signal?)` takes the installer as a
  required parameter (production: `installCheckout`), so the spare tests run
  without a CLI and no caller can make a ready-but-uninstalled spare.
- `bin/stop-guard.ts` is now a bootstrap like `guard.ts`: stamp check, then
  `import("./stop-hook")` (the old body). `guards:bootstrap-builtins-only` now
  measures both entry points.
- **Disk:** one install into a scratch checkout of this branch (`df -k` on the
  data volume before/after, a build running concurrently so it is noisy):
  ~31 MB of real blocks and ~76k inodes, for a root `node_modules` of 1.35 GB
  apparent (`du`). bun's clonefile layout makes a spare's install cheap on
  APFS. 16 s wall, cold stamp, warm bun cache.
- Not verified by hand: running the guard bootstrap with a bare `bun` against
  an uninstalled checkout — the `bun-script` guard refuses bare `bun <file>`,
  and `./equin run` would install first. Covered by `bootstrap.test.ts`
  (an uninstalled temp checkout gets main's verdict with the named reason, no
  stack).
