# Stray worktree gitlink on main — remove it, and make gitlinks uncommittable

## Context

`.claude/worktrees/claude-1775848273` is tracked on `main` as a gitlink (mode
160000, pointing at `1d88d575`), with no `.gitmodules`. Symptoms:

- `git submodule status` dies (`no submodule mapping found in .gitmodules`).
- `git ls-files` lists a path that is a directory on disk. The code-explorer file
  tree (`code-explorer/server/internal/tree-handler.ts`) and the fuzzy path
  resolver (`file-resolve/.../resolve-handler.ts`) list it as a "file";
  `checks/core/read-set.ts:191` has to skip it.
- Every agent checkout gets an empty directory at that path (git materializes an
  uninitialized gitlink as an empty dir).
- The main checkout is permanently dirty: `git status` there shows
  ` D .claude/worktrees/claude-1775848273` (the worktree it pointed at is gone).

### How it got there (recovered from history)

The DB cannot answer this: the oldest conversation row is 2026-04-13, three days
after the commit, and Claude Code's own April transcripts are gone. Git history
answers it completely:

| Commit | Date | Gitlinks under `.claude/worktrees/` |
|---|---|---|
| `896f87320` "Start CLI" | 04-10 19:30 | + `loving-saha` |
| `78d1f3db1` "Add top level CLI" | 04-10 19:45 | + `agitated-galileo`, `optimistic-feynman` |
| `1d88d5751` "Start claude in worktree always" | 04-10 20:12 | + `claude-1775844594`, `worktree-switcher` |
| `7beea7ac3` "Add claude session" | 04-10 21:23 | + `claude-1775848273` |
| `997e3b3b8` "Ignore worktree directories…" | 04-11 11:19 | − `loving-saha`, `optimistic-feynman`, `worktree-switcher` (+ `.gitignore` entry) |
| `81f9831e9` "Fix PTY exhaustion…; add --from-main" | 04-14 09:02 | − `agitated-galileo`, `claude-1775844594` |

So it was not one accident but a pattern: four consecutive hand commits from the
main checkout on 04-10, each a whole-tree `git add -A`-style stage, each sweeping
in whichever Claude Code worktree checkouts existed (each gitlink pins the main
commit that worktree branched from). `./equin push` did not exist yet
(added 04-11). The two cleanups each removed only the checkouts whose
directories were gone at that moment — `81f9831e9` came in through a
`--from-main` push whose `git add -A` staged the deletions incidentally.
`claude-1775848273` is the survivor of an interrupted cleanup, not a
deliberate entry. **Removing it finishes that cleanup.**

### Does anything still allow it?

The `.gitignore` entry closes the original vector (a Singularity agent
worktree lives at `<main>/.claude/worktrees/<id>`, which `git add -A` from main
now skips). What remains open:

1. **The leftover entry itself.** Tracked paths ignore `.gitignore`. Today the
   main checkout carries its unstaged deletion, so the next
   `./equin push --from-main -m …` would sweep that deletion into an
   unrelated commit (the exact way two of its siblings left). Had the directory
   still existed with a moved HEAD, it would have swept in a new gitlink SHA.
2. **Any nested checkout outside `.claude/worktrees/`.** `push` stages with
   `git add -A` (`cli/plugins/push/cli/run.ts:359`; the post-rebase amend in
   `cli/plugins/git-artifacts/cli/normalize-generated.ts:162` does too). Any
   directory holding a `.git` (a `git clone`, `git init`, or `git worktree add`
   into an un-ignored path) is committed as a gitlink; git only prints a warning.
3. **Forced adds** (`git add -f .claude/worktrees/x`).

Nothing checks for any of these.

## Design

The repo has no submodules and no `.gitmodules`, so **every gitlink is wrong**.
There is no allowlist to maintain. Adopting a submodule someday is a deliberate
decision that should revisit this check.

### 1. Remove the entry

`git rm --cached .claude/worktrees/claude-1775848273` in this worktree (index
only; the empty directory on disk is gitignored afterwards), committed through
`./equin push -m`. On main this is a fast-forward. The main checkout's
permanent ` D` line goes away, and so do the empty directories in the other
agent checkouts once they rebase.

### 2. New check `no-gitlinks` (rung 3: check error, run on every push and build)

Why a check and not a higher rung: git has no config that makes `git add`
refuse an embedded repository (only `advice.addEmbeddedRepo`, a warning), so
"inexpressible" is not available. There are two staging sites; a check covers
both, plus raw commits and `--from-main`, from one place. It runs at every push
(the rebased-tree check pass, which `push` cannot skip) and at every build.

Plugin: `plugins/framework/plugins/tooling/plugins/checks/plugins/no-gitlinks/`
(`check/index.ts`, `CLAUDE.md`, `package.json`), modelled on
`generated-artifacts-normalized/check/index.ts` (typed `Check` from
`@plugins/framework/plugins/tooling/core`, `getWorktreeRoot`/`spawnCaptured`
from `@plugins/infra/plugins/spawn/core`).

It fails when either holds:

- **Tracked gitlink** — `git ls-files -s -z` has a mode `160000` entry. After
  `push`'s commit step this is exactly "the commit about to merge contains a
  gitlink". Hint: `git rm --cached <path>`, then push again.
- **Nested checkout `git add -A` would sweep in** — `git ls-files -o
  --exclude-standard -z` lists an entry ending in `/`. Without `--directory`,
  ls-files recurses into ordinary untracked directories and lists only files.
  The one thing it shows as `dir/` is a directory it refuses to descend into
  because it holds its own repository, which is precisely what `git add -A`
  turns into a gitlink. This fires at `build` / `./equin check`, before
  anything is committed. Hint: move the checkout outside the repo, or gitignore
  its path.

`cacheSignature: () => null`: the verdict reads the real index, which the
tree-hash (a scratch `add -A` + `write-tree`) does not capture exactly: an
index gitlink whose directory is gone is dropped from the scratch tree. Two
metadata-only git reads per run; caching buys nothing.

Message names the concrete consequence (`git submodule` breaks, git-based file
listings show a directory as a file, every checkout grows an empty directory),
listing each offending path.

### Not changing

- `read-set.ts:191`'s non-blob skip stays. It is a generic `ls-tree` parser,
  and the check now owns the invariant.
- code-explorer's `ls-files` endpoints need nothing: the phantom disappears with
  the entry, and the check keeps it from coming back.

## Verification

1. Before the fix, `./equin check no-gitlinks` fails naming
   `.claude/worktrees/claude-1775848273`. After `git rm --cached` it passes.
2. Nested-repo arm: in a scratch dir, `git init` a repo, `git init sub` inside
   it with one commit, and confirm `git ls-files -o --exclude-standard` prints
   `sub/` while an ordinary untracked dir prints its files. Also try a
   `git worktree add` target (a `.git` *file*, the April shape).
3. `./equin build` (runs all checks, including `plugins-doc-in-sync`,
   `plugins-registry-in-sync` and `type-check`) succeeds.
4. After push: `git ls-files -s | awk '$1==160000'` on main is empty, and
   `git submodule status` exits 0.
