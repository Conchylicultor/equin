# worktree

Git worktree CRUD primitive: resolve the main worktree root, derive per-id paths, create and remove worktrees.

`ensureMainWorktreeRoot()` caches the repo root (the parent of `.claude/worktrees/*`, not the current worktree — `git rev-parse --show-toplevel` would return the latter when the server runs inside a worktree). All exports are async; first call resolves the cache, subsequent calls return immediately.

## Why `setupWorktree` probes for the branch first

`git worktree add -b` creates the branch before writing the checkout. An add killed
part-way (a backend restart signals the whole process group, git included) deletes
its half-written directory but keeps the branch, so a retry with `-b` can only fail
with "branch already exists". An existing `claude-web/<id>` is therefore checked out
instead of re-created.

## Spare pool (`server/internal/spare.ts`, claim in `worktree.ts`)

A launch's checkout is ~16k file writes (5–10 s). To take it off the launch path,
a **spare** — a detached checkout of `main` at `.claude/worktrees/spare-<ms>-<rand>`
— is written beforehand, and `setupWorktree` claims it instead of running a cold
`git worktree add`. It returns `{ source: "spare" | "fresh" | "existing" }`; the
caller (`conversations.spawn`) refills the pool after a `spare` or `fresh`
checkout. The refill job, its boot warm-up and its daily cron live in the
`spare-pool` sub-plugin — this plugin stays job-free, because the CLI imports it.

- **The lock reason is the readiness marker.** A spare is written
  (`add --detach`, sharing `addCheckout` with the cold path: one
  `checkout.workers=0`, one timeout, one partial-tree cleanup) and only then
  locked with reason `singularity-spare`. `listReadySpares` lists only spares
  locked that way, so a half-written one is never claimed. The lock also keeps
  Claude Code's own `.claude/worktrees` sweep away from it.
- **`spare-*` is non-canonical on purpose.** It fails `isCanonicalWorktreeName` (not an attempt id), so the
  reaper, the namespace passes and the registry filters ignore it. Do not widen
  the regex.
- **The claim** (inside the mutate-gate hold): `unlock` → `git worktree move` →
  `git switch [-c] claude-web/<id>` (a two-tree checkout: it writes only the diff
  since the spare's commit) → lock. Two claimers of one spare are told apart by
  git: the first `unlock` wins, and `move` is a rename; the loser tries the next
  spare, then the cold add.
- **Crash convergence.** A crash between `move` and `switch` leaves the dir in
  place on a detached HEAD. The early return finishes the switch when
  `isUnfinishedSpareClaim`: admin dir `spare-*` (the move keeps it), HEAD
  detached, and NO lock — a finished claim is always locked, so a working
  checkout on a detached HEAD (mid-rebase) is never switched.
- **Pruning.** `pruneSpares` removes `spare-*` dirs that are unregistered or
  unlocked and older than 15 minutes (newest of the dir's and its admin dir's
  mtime — an `unlock` touches the admin dir), and ready spares older than a day,
  taken by `unlock` first so a concurrent claim wins.

## Cancellation

`setupWorktree(id, path, compositionIds, signal?)`,
`removeWorktree(path, signal?)` and `withWorktreeMutateSlot(fn, signal?)` all take
an optional ambient `AbortSignal` — a job handler passes its `ctx.signal`.

This is the gate where cancellation matters most. A handler stuck inside the
`worktree-mutate` acquire, or inside a `git worktree remove` while holding one of
its three host-wide slots, is not stalling itself: it is stalling worktree
checkouts on every backend on the machine (the 2026-08-17 outage). Aborting such a
handler means nothing unless the abort reaches the wait, so the signal is forwarded
to BOTH the host pool (a pending acquire unwinds; an abort mid-body hands the slot
back immediately) and every git child underneath, which `spawnCaptured` kills on
abort before throwing `signal.reason`.

Two children are deliberately left unbound, and both for the same reason: the
`git worktree prune` after a killed `worktree add`, and the one after the
unregistered-leftover `rm`. Each is the tail of an operation already committed to,
so cancelling it would trade a released flock for a partial checkout the next retry
mistakes for a finished one, or a leaked `.git/worktrees` entry. Their own timeouts
bound them instead.

## Op liveness markers (`server/internal/worktree-op.ts`)

`markWorktreeOpStart(slug, kind, opId)` publishes
`~/.singularity/worktrees/<slug>/ops/<opId>.json` = `{v:2, kind, opId, pid,
startedAt}` and returns a handle whose `release()` unlinks it. The file is
written to a `.tmp` sibling, `flock`ed, then renamed into place, and the lock is
held for the op's life. **The lock is the liveness**: the kernel drops it when
the process dies — SIGKILL and OOM included — and no pid is consulted, so pid
reuse cannot keep a dead op alive. The fd is close-on-exec (Bun/libuv open every
fd `O_CLOEXEC`), so a child the op spawns cannot inherit and outlive the lock;
the marker test pins that with a real SIGKILL while a grandchild keeps running.

A marker says only *whether* an op runs; what it is doing (queued, parked on a
wait, working) is the op log's business. Readers — `listWorktreeOps`,
`listActiveWorktreeOps`, `isWorktreeOpActive`, `probeWorktreeOp` — try-lock each
file: failing ⇒ live; succeeding ⇒ the holder is gone, and the file is reaped.
`.tmp` files are never probed (a probe between the writer's create and its
flock would steal the lock) and are reaped only when a minute stale.

Ordering is the caller's job, and every op command does it the same way:
publish the marker → append `requested` → … → append `completed` → `release()`.
So a reader that sees the marker gone always finds the verdict already written.

**Op signal.** After every publish, release and reap, the writer/reader also
touches `~/.singularity/state/worktree-op-signals/<slug>` (`opSignalsDir`, this
plugin's `data-dirs` barrel — usable from CLI processes too, since it is plain
`node:fs` path resolution). The file's content means nothing; it is a wake-up for
a watcher wanting "this worktree's live ops may have changed" (the tmux status
reconciler) without watching every worktree dir recursively, where builds write
thousands of output files. The directory is ensured on each touch, and any
other failure propagates (a failed touch at publish fails the op's start).
`conversations/runtime-tmux`'s daily prune deletes day-old files.

Transition (until phase 5 of `research/2026-09-29-global-unified-op-status.md`):
legacy per-kind `ops/<kind>.json` markers from an older CLI are still read, with
pid liveness.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Server:
  - Uses:
    - `infra/host/host-admission.defineHostPool`
    - `infra/paths.GIT`
    - `infra/paths.worktreeArtifacts`
    - `infra/paths.worktreeDataDir`
    - `infra/paths.worktreesDir`
    - `packages/flock.flockTry`
  - Exports (types):
    - `CheckoutSource`
    - `CompositionMarker`
    - `NamespaceClaimant`
    - `NamespaceProbe`
    - `WorktreeOp`
    - `WorktreeOpInfo`
    - `WorktreeOpMarker`
    - `WorktreeSetup`
    - `WorktreeSpec`
  - Exports (values):
    - `countReadySpares`
    - `createSpareWorktree`
    - `ensureMainWorktreeRoot`
    - `gitWorktreesDir`
    - `hasCompositionMarker`
    - `isCanonicalWorktreeName`
    - `isCanonicalWorktreePath`
    - `isWorktreeOpActive`
    - `listActiveWorktreeOps`
    - `listWorktreeOps`
    - `listWorktreePaths`
    - `markWorktreeOpStart`
    - `namespaceCollision`
    - `probeNamespace`
    - `probeWorktreeOp`
    - `pruneSpares`
    - `readCompositionMarker`
    - `removeWorktree`
    - `removeWorktreeSpec`
    - `setupWorktree`
    - `stampCompositionMarker`
    - `withWorktreeMutateSlot`
    - `WorktreeGitTimeoutError`
    - `worktreePathFor`
    - `writeWorktreeSpec`
- Cross-plugin:
  - Imported by: 24 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `debug` ×5
    - `infra` ×5
    - `tasks` ×4
    - `build` ×2
    - `conversations` ×2
    - `stats` ×2
    - `backup/sources/databases`
    - `code-explorer`
    - `plugin-meta/plugin-health`
    - `release/source-checkout`
- Core:
  - Exports (types):
    - `OpKind`
    - `OpKindMeta`
  - Exports (values):
    - `attemptBranchName`
    - `attemptBranchRef`
    - `isOpKind`
    - `OP_KIND_IDS`
    - `OP_KINDS`
    - `stripAttemptBranchPrefix`
- Sub-plugins:
  - **`reclaim`** — Namespace reclaim: reclaimNamespace tears down one compose-serve namespace's four artifacts (database, config dir, gateway registry dir, and the composing checkout's filtered registries) behind…
  - **`spare-pool`** — Spare worktree pool: the worktree.spare-refill job (enqueued after every launch's checkout, at main's boot, and daily) keeps one locked, detached checkout of main ready under…

<!-- AUTOGENERATED:END -->
