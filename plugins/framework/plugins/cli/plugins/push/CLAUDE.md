# push

`./equin push` — the one path work reaches `main`.

`cli/index.ts` is the data-only declaration (`-m, --message`, `--from-main`,
`--unattributed`);
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
replay onto), so the commit carries the push trailer itself
instead of receiving it from the rebase's `--exec`.

## The critical section

Everything from the fetch onward runs inside `withPushLock`. The mutex is scoped
to the repository whose `main` it guards (`pushLockFor`): for the repository this
machine's main app is served from, it is the single slot of the `push` host pool
— `~/.equin/locks/push/slot-0.lock` — and who holds it and who queues on it
is read from the op log (the push's `push-mutex` wait and its `granted`), not
from the lock file. Any other repository (a second clone, an e2e's temp repo)
locks in its own git dir (`<common-dir>/<git lock dir>/push/`), so its push
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
     trailer. The rebase exists only to make step 8's ff-merge possible, already
     true here, and it would **rewrite the merged-in upstream commits**: measured,
     upstream's own sha stopped being an ancestor of main, so the next
     `upstream merge` based below them and re-presented merged changes as
     conflicts. Cost, accepted: the ledger groups the tip alone.
   - **merge commits, but main moved past** → refuse, and say to `git merge main`
     in the worktree. Never fall through to the flattening rebase.
   - **otherwise** → `git rebase main --exec <stamp>`, unchanged.

   Then, **a fix claim must land on a commit** (`cli/fix-claim.ts`). Trailers
   ride only the commits a push lands, so a push naming a report that lands
   none — a clean tree already equal to main, or every commit dropped by the
   rebase — used to print "Done" with the claim silently dropped. Now a
   `--report-fixed-by`-only push gets an empty commit of its own (its `-m`,
   every landing trailer; no `-m` is refused), and a `--fixes-report` push is
   refused (landing nothing, it cannot be the fix). Decided after the rebase,
   so nothing replays or drops that commit; `--from-main` runs the same step
   after its own rebase (local mode: only step 1's commit counts).
4. **hand off to the land phase** — steps 5–8 run in a child on the REBASED
   code (below), inside this mutex and grant
5. install what the rebase brought in — the land phase's own bootstrap
   (`ensureDeps`, frozen through `EQUIN_FROZEN_LOCKFILE`), before its code loads
6. `normalizeGeneratedArtifacts(…, { force: true })` — re-derive and amend
7. `check --scope tree` in a subprocess, handed the section's grant (below)
8. push the branch, then push it as the remote's `main` (both publish mode
   only), then ff local `main` — **remote first**. The mutex serializes this
   machine's pushes, not every writer of the remote (a GitHub web edit, another
   clone). With local `main` advanced first, a remote that moved in between
   refused the push and left local `main` holding a commit the remote never got:
   diverged, inherited by every new worktree, and the next push failed at its
   `--ff-only` pull. Now the remote's non-fast-forward refusal is the atomic
   gate; `publishMain` tells that race (local `main` untouched, re-run) from an
   access refusal (re-probe, as above).

**Steps 3–8 run under ONE interactive CPU grant**, taken by `withPushLock` as
the first thing inside the mutex and passed to its body (and from there to the
check subprocess). Every queued push waits on the holder for its whole hold, so
the whole hold is human-blocking: the interactive lane runs it in the foreground
(`withHostGrant`). Taken only around the checks, as it once was, the rebase,
install and normalize ran at the agent session's inherited darwinbg tier —
normalize, ~13 s of work, took a median 109 s on the E-cores
([`research/2026-10-15-global-push-lock-holder-foreground.md`](../../../../../../research/2026-10-15-global-push-lock-holder-foreground.md)).

5 before 6 on purpose: the regen must run against a `node_modules` matching the
tree it regenerates. Push's own rebases set `SKIP_POST_REWRITE_ENV` so the
`post-rewrite` hook does not normalize underneath it — push owns this ordering.

## The land phase: after the rebase, the rebased code runs

The rebase moves the checkout the push process was started from, so from then on
that process is OLDER than its tree. Left running it mixes versions: its children
run the new tree, it keeps the old one in memory, yet it still reads the tree by
path (a script it spawns, a lazy import) and leans on on-disk layout (its own
executable). On 2026-11-06 a rebase brought in a change that deleted the running
push's executable name, and the push died at its last step after remote main had
moved ([`research/2026-11-06-cli-push-post-rebase-handoff.md`](../../../../../../research/2026-11-06-cli-push-post-rebase-handoff.md)).

So `cli/run.ts` (the **driver**) does nothing after the rebase but run the
**land phase** and record it: `./equin push` again, through the script (never
`process.execPath`), with the hand-off in `EQUIN_PUSH_LAND`. That child
(`cli/land.ts`) runs steps 5–8 on the rebased code. Always — not only when the
rebase touched the push's own code: 35–57 % of main's commits do, so a gate
would fire on nearly every push and buy nothing.

- **The lock never moves.** The driver keeps holding the mutex and the grant and
  the land phase runs inside that hold, the grant handed down by env like the
  checks' (`grant.env()` → `inheritedGrant()`). Releasing the mutex to re-run the
  push was measured out: 31 % of pushes have another land while they queue, so a
  restart would rebase again. The child dies with the driver (orphan guard).
- **It is nested.** No op record, no worktree-op marker, no mutex request: the
  driver owns all three. The op log has one writer per op, so the land phase
  writes its steps and outcome to a report file
  (`worktreeArtifacts.pushLand`), which the driver copies onto the op (plus a
  `land-boot` step: the child's start-up and install).
- **`cli/handoff.ts` is the whole contract between two versions** — the
  driver's (before the rebase) and the land phase's (after it): the env
  payload, the report, and the grant env. Every shape carries `v`; change one
  and bump `v`, reading the previous one until no older checkout is left.
- **State is re-derived, not handed over**: the land phase reads branch, root,
  main's worktree and the publish target from git; only the push id, the mode
  and the report path cross.

## `--from-main`

Commits and pushes straight from `main`, skipping the worktree merge. Carries a
hard rule, stated in the flag's own help text: **an agent must never pass it
without explicit user approval in the current conversation.** Still takes the
mutex, still runs the checks.

In publish mode it rebases the checkout's own `main` onto `origin/main` *before*
its final push, so a push that fails leaves local main advanced and already
rebuilding. Long-standing, now stated in the code; the local arm never pushes,
so it cannot happen there.

## Attribution: who a push credits (`cli/attribution.ts`)

Beside the push trailer, every landed commit is stamped with what names its
task — decided once, before anything is written:

- **an attempt's branch** (`claude-web/<attemptId>`, `attemptOfBranch` in
  `tasks-core/core`) → the `Equin-Attempt` trailer, always. Derived from the
  checkout, not from `EQUIN_CONVERSATION_ID`, so a session equin did not launch
  (recovering a broken main from a plain terminal) still lands credited. The
  conversation trailer, when the hook stamped one, stays the ledger's authority.
- **`--unattributed "<reason>"`** → `Equin-Unattributed: <reason>`, for a branch
  that is no attempt's pushed from such a session. Refused whenever the push is
  attributable (the env var is set, or the branch is an attempt's), so it can
  never discard a real name. Same rule as `--from-main`: an agent passes it only
  with the user's explicit approval in the current conversation. The ledger
  writes no row for it; git history keeps the reason.

The trailers reach the rebase `--exec` as one single-quoted shell string
(`trailerAmendCommand`), since a reason is free text.

## Fatal signals

A push owns no deploy receipt, so the fatal-signal tap armed here is its only
record of being killed — and it is the op where that costs most, since the box
queues behind the mutex it was holding.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: `./equin push` — the one path work reaches main: commit, rebase onto main, re-normalize generated artifacts, run the tree-scoped checks, fast-forward and push, all under the host-wide push mutex.
- Cli:
  - Uses:
    - `framework/cli/git-artifacts.normalizeGeneratedArtifacts`
    - `framework/cli/op-runtime.checkBroadcasts`
    - `framework/cli/op-runtime.installFatalSignalExit`
    - `framework/cli/op-runtime.opPriority`
    - `framework/cli/op-runtime.reportInterruptedPredecessorSync`
    - `framework/cli/op-runtime.runCheckSubprocess`
    - `framework/cli/op-runtime.signalOriginTap`
    - `reports/engine.resolveFixedReports`

<!-- AUTOGENERATED:END -->
