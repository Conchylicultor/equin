# Main's build never dirties main; push says so when main is dirty anyway

## Context

On 2026-10-17 `./singularity push` from `claude-1792232269` failed at the merge step:
`git merge --ff-only` in the main checkout aborted with *"Your local changes … would be
overwritten by merge: docs/plugins-details.md …"*. By then the branch had already been pushed
to origin, but main had not moved. The main checkout (HEAD `25df26786e`) carried edits that
nobody made by hand, all of them autogen doc output: `config_v2` now listed as a user of
`ui/tokens/shadow --shadow` (61 → 62 plugins). It also had an untracked
`plugins/config_v2/web/internal/git-layer.generated.ts`. Since then someone has cleaned the
checkout by hand; it is clean now at `a976e508b8`.

### Q1: why main's own build produced a doc diff (root cause)

The committed docs were correct. Main's build saw an input that no worktree has.

1. `a2764a8a43` introduced `plugins/config_v2/web/internal/git-layer.generated.ts`. The build
   wrote it after docgen, and `.gitignore` listed it. Main built that commit, so the file was
   on main's disk.
2. `7f74d8862b` made docgen read git's file set (`loadRepoFiles` = `git ls-files --cached
   --others --exclude-standard`, `plugin-tree/core/internal/fs-snapshot.ts`). Docgen stopped
   seeing that file because it was ignored.
3. `25df26786e` moved the layer to `/.generated/composition-modules/` and **deleted the old
   `.gitignore` line**. Nothing deleted the old file from disks that already had it. On main
   the stale file became *untracked and not ignored*, so docgen saw it again.
4. Its JSON contains `"ui.tokens.shadow:shadow"`. The token-usage scanner (Tailwind oxide over
   `config_v2/web/**`, `facets/plugins/cross-refs/facet/index.ts`) reads the bare word `shadow`
   as a `--shadow` use. That is the same false positive 7f74 fixed.
5. Main's auto-build (`build/server/internal/run-build.ts`: `./singularity build --allow-main`)
   runs `regenerateManifestCodegen` in write mode and rewrote the four doc files in the
   tracked tree.

The pusher's worktree had never built at a2764a8, so it had no stale file and
`plugins-doc-in-sync` passed at push. Both computations are correct; their inputs differed.

**General shape:** main's checkout accumulates on-disk state that worktrees don't have (stray
outputs of older builds, files un-ignored by a later `.gitignore` change). Main's build then
treats the checkout as a writable worktree. Any such difference shows up as tracked-file edits
on main.

### Q2: why a dirty main blocks every push

`push/cli/run.ts` never inspects the main checkout. Its first contact with the dirt is git's own
abort in step 6 (`exec` → bare `process.exit(1)`). That happens *after* step 5 has already
pushed the branch to origin. Agents are rightly guarded from writing to main, so the fleet stays
stuck until a human cleans it.

## Design

Two independent changes. The first removes the cause: main's build becomes inexpressibly unable
to dirty main. The second makes the remaining case (dirt from any other source) loud, early and
attributable.

### 1. Main's tracked tree is read-only to its own build

The committed tree on main is, by construction, what `plugins-doc-in-sync` /
`plugins-registry-in-sync` / … accepted at push. Main's build therefore has nothing legitimate
to write to a tracked (or untracked-not-ignored) path. Only gitignored build outputs
(`.generated/`, `dist*`) may change.

- In `plugins/framework/plugins/cli/plugins/build/cli/run.ts`, after the last writer
  (`formatChangedSources`, ~L1196) and before deploy, when building the main checkout
  (`--allow-main`/`isMainCheckout`), assert `git status --porcelain` is empty.
  - This is a single assertion after all writers, not a per-generator mode. It catches every
    writer (docgen, registries, config origins, the formatter, future generators) with no audit
    of `writeGenerated` call sites.
- On violation:
  1. Capture the drift (`git diff --stat` plus the list of untracked, non-ignored files, which
     are the likely culprit inputs, as here).
  2. Restore the tracked paths to HEAD (`git checkout -- <modified paths>`) so the checkout
     stays clean for the fleet. Untracked files are **listed, never deleted**, because they are
     the evidence.
  3. File a report through `reports/outbox` (`fileReportFromProcess`,
     `plugins/reports/plugins/outbox/core`), with the diff stat and the untracked suspects.
  4. **Fail the build** (exit non-zero, so the Deploy app shows the failed run). The previous
     server keeps serving.
  - This is a loud failure, not a masked one: the build fails and a report names the cause. The
    restore only stops the failure from spreading to every push.
- A new helper in the build plugin, say `assertMainTreeUntouched(root)`, holds this logic. It
  uses the existing `run`/spawn helpers there.

> Alternative considered: a "verify mode" that routes every generator write through
> `writeGenerated` and compares instead of writing on main. It is cleaner in theory, but it
> needs every generator to use that one writer. Several write directly (`docgen.ts`, the
> formatter), so it leaves holes a post-hoc `git status` can't have. Rejected for now.

### 2. Push refuses a dirty main up front, before touching the remote

- In `push/cli/run.ts`, inside `withPushLock` and **before step 2** (fetch / ff main), and
  therefore before the step-5 branch push, run `assertMainCheckoutClean(mainWorktree)`. It runs
  `git status --porcelain --untracked-files=no` in the main worktree.
  - If dirty, refuse with a message that:
    - lists the files;
    - says *"the main checkout has local changes this push did not make; nothing was pushed"*;
    - says agents must not edit main;
    - points at the main build report (from §1) or asks the user to clean main.
  - Exit 1. The branch is not left half-published.
  - Untracked files are not checked: they only collide when the incoming range adds the same
    path, and git reports that case precisely.
- The `--from-main` path (L582–680) is out of scope. It is user-approved and runs in main
  itself.

### 3. The stale file itself (root-cause hygiene)

- Generated outputs now live under the gitignored `/.generated/`. 25df already did this for the
  config layer.
- The one-off stale file is gone from main. Worktrees that built at a2764a8 may still carry it.
  §1 doesn't cover them, but their own `build` would show the doc diff in their branch.
  `plugins-doc-in-sync` would then pass with the wrong docs, and the stale config_v2 → shadow
  edge would land on main.
  - To close that, `generateConfigGitLayer` removes the legacy
    `plugins/config_v2/web/internal/git-layer.generated.ts` if present. That is one `rmSync`
    with a comment pointing at 25df, deletable later.
  - The general version ("a generator that moves its output removes the old path") is not
    worth a primitive yet. §1 makes any recurrence loud on main.

## Files

- `plugins/framework/plugins/cli/plugins/build/cli/run.ts`: call the post-writer main-tree
  assertion; new helper beside it under `build/cli/internal/`.
- `plugins/framework/plugins/cli/plugins/push/cli/run.ts`: `assertMainCheckoutClean` before
  step 2.
- `plugins/framework/plugins/tooling/plugins/codegen/core/config-git-layer-gen.ts`: remove the
  legacy output path.
- Reuse: `fileReportFromProcess` (`reports/outbox/core`), the existing `run`/`spawnPassthrough`
  helpers in each CLI.
- Update the Push section of `CLAUDE.md` (step list) and the build plugin's CLAUDE.md: "main's
  build never writes tracked files".

## Verification

- Unit: the helper's classification (clean / tracked-modified / untracked-only), tested with a
  temp git repo (`./singularity test plugins/framework/plugins/cli/plugins/build`, `…/push`).
- Push preflight, simulated in a scratch clone with two worktrees: dirty a tracked file in the
  "main" worktree, run push, and confirm it refuses before any `git push`, with the file listed.
- Build assertion: in a scratch clone, drop an untracked
  `plugins/config_v2/web/internal/git-layer.generated.ts` (containing `ui.tokens.shadow:shadow`)
  on the main checkout and run `build --allow-main` there. Expect: build fails, report filed,
  tracked docs restored (`git status` shows only the untracked suspect).
- `./singularity build` in this worktree plus `./singularity check` stay green.

## As implemented (deviations from the above)

- **No separate report kind.** A failed main auto-build already rings the bell and
  shows in Deploy with its Investigate action, and the build transcript carries
  the drift account, so the guard prints and exits 1 rather than filing a report.
- **Restore only what can't lose an edit.** The guard snapshots `git status`
  (content-hashed) before stage 1 and after the formatter, and restores a path
  only when it was clean before the build AND `.gitattributes` routes it to a
  `merge=regen-*` driver. Anything else is listed, not restored: a hand edit on
  main, or the user's in-flight `--from-main` work. Untracked files are never
  removed. Code: `build/cli/internal/main-tree-guard.ts`.
- **Push refuses only on a collision**, not on any dirt. The refusal fires when
  dirty or untracked paths in main overlap `git diff HEAD <target>` ∪
  `git diff <target>...<branch>`. It runs after the fetch and before the ff of
  main and the branch push. A change on a path the merge doesn't touch never
  blocked a push, and still doesn't.
- The legacy-file removal runs in `generateConfigGitLayer`, i.e. after docgen
  within the same build. The first build on an affected checkout still sees the
  stray file (on main the guard catches and restores that), and the next one is
  clean.
