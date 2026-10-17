# push

`./singularity push` — the one path work reaches `main`.

`cli/index.ts` is the data-only declaration (`-m, --message`, `--from-main`);
`cli/run.ts` is the implementation, reached through the declaration's lazy
`import()` so no other invocation pays for the host-admission, worktree and
op-profiler barrels it pulls in.

## Publishing is asked about, not assumed

Before the mutex, push asks `infra/git/remotes` whether this checkout may write
to its remote (a cached `git push --dry-run` probe — read that plugin's
`CLAUDE.md` for how the answer is measured and when it is re-taken).

- **publish** — the flow below, unchanged.
- **local** — the three steps that touch the network are skipped: the
  `fetch` + `merge --ff-only origin/main` at the start, the branch push, and the
  push of `main`. Everything else is identical, so local `main` still advances
  and still rebuilds itself. The reason is printed once, up front, so the
  difference is never silent, and the final line says nothing was pushed.

This is the ordinary state of a clone, not a broken checkout. The gate on the
*fetch* matters most: left in, it would pull another repository's commits into
the user's own `main` on every push, and break push for good the first time
their main diverged.

A push the remote REJECTS re-probes and records the answer
(`recordPushRejection`), because a rejection is newer evidence than the cache —
so a checkout that loses write access lands in local mode next time instead of
failing forever.

`--from-main` in local mode has no rebase at all (there is no `origin/main` to
replay onto), so the commit carries the `Singularity-Push` trailer itself
instead of receiving it from the rebase's `--exec`.

## The critical section

Everything from the fetch onward runs inside `withPushLock`. The mutex is scoped
to the repository whose `main` it guards (`pushLockFor`): for the repository this
machine's main app is served from, it is the single slot of the `push` host pool
— `~/.singularity/locks/push/slot-0.lock` — and who holds it and who queues on it
is read from the op log (the push's `push-mutex` wait and its `granted`), not
from the lock file. Any other repository (a second clone, an e2e's temp repo)
locks in its own git dir (`<common-dir>/singularity-locks/push/`), so its push
never queues the machine's real pushes. Either way at most one push per
repository runs at a time, so two agents can never race on one `main`.

Before the lock, push asserts that the main worktree it will fast-forward
belongs to the same repository as the checkout it was run from (git common dir,
and no inherited `GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR`). Inside the
mutex the order is load-bearing:

1. commit (only with `-m`) — a dirty tree without a message is refused
2. consume any merge marker this push did **not** produce
3. fetch (publish mode only), then **refuse if a local change in main's
   checkout collides with a path the merge will rewrite** (`assertNoMainCollision`:
   dirty or untracked paths ∩ (main → target ∪ target...branch)). This happens
   before anything reaches the remote. Unchecked, git's "local changes would
   be overwritten" abort came at the final ff, after the branch was already
   pushed. Dirt elsewhere does not refuse. Then ff `main` (publish mode only)
   and put the branch in landable shape
   — three arms, decided by `main..HEAD`:
   - **contains main** → *no rebase at all*; only the tip is amended with the
     trailer. The rebase exists only to make step 7's ff-merge possible, already
     true here, and it would **rewrite the merged-in upstream commits**: measured,
     upstream's own sha stopped being an ancestor of main, so the next
     `upstream merge` based below them and re-presented merged changes as
     conflicts. Cost, accepted: the ledger groups the tip alone.
   - **merge commits, but main moved past** → refuse, and say to `git merge main`
     in the worktree. Never fall through to the flattening rebase.
   - **otherwise** → `git rebase main --exec <stamp>`, unchanged.
4. `ensureDeps({ frozenLockfile: true })` — install what the rebase brought in
5. `normalizeGeneratedArtifacts(…, { force: true })` — re-derive and amend
6. `check --scope tree` in a subprocess, handed the section's grant (below)
7. push the branch (publish mode only), ff `main`, push `main` (publish mode only)

**Steps 3–7 run under ONE interactive CPU grant**, taken by `withPushLock` as
the first thing inside the mutex and passed to its body (and from there to the
check subprocess). Every queued push waits on the holder for its whole hold, so
the whole hold is human-blocking: the interactive lane runs it in the foreground
(`withHostGrant`). Taken only around the checks, as it once was, the rebase,
install and normalize ran at the agent session's inherited darwinbg tier —
normalize, ~13 s of work, took a median 109 s on the E-cores
([`research/2026-10-15-global-push-lock-holder-foreground.md`](../../../../../../research/2026-10-15-global-push-lock-holder-foreground.md)).

4 before 5 on purpose: the regen must run against a `node_modules` matching the
tree it regenerates. Push's own rebases set `SKIP_POST_REWRITE_ENV` so the
`post-rewrite` hook does not normalize underneath it — push owns this ordering.

## `--from-main`

Commits and pushes straight from `main`, skipping the worktree merge. Carries a
hard rule, stated in the flag's own help text: **an agent must never pass it
without explicit user approval in the current conversation.** Still takes the
mutex, still runs the checks.

In publish mode it rebases the checkout's own `main` onto `origin/main` *before*
its final push, so a push that fails leaves local main advanced and already
rebuilding. Long-standing, now stated in the code; the local arm never pushes,
so it cannot happen there.

A push owns no deploy receipt, so the fatal-signal tap armed here is its only
record of being killed — and it is the op where that costs most, since the box
queues behind the mutex it was holding.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: `./singularity push` — the one path work reaches main: commit, rebase onto main, re-normalize generated artifacts, run the tree-scoped checks, fast-forward and push, all under the host-wide push mutex.
- Cli:
  - Uses:
    - `framework/cli/bootstrap.ensureDeps`
    - `framework/cli/git-artifacts.normalizeGeneratedArtifacts`
    - `framework/cli/git-artifacts.SKIP_POST_REWRITE_ENV`
    - `framework/cli/op-runtime.checkBroadcasts`
    - `framework/cli/op-runtime.installFatalSignalExit`
    - `framework/cli/op-runtime.reportInterruptedPredecessor`
    - `framework/cli/op-runtime.runCheckSubprocess`
    - `framework/cli/op-runtime.signalOriginTap`

<!-- AUTOGENERATED:END -->
