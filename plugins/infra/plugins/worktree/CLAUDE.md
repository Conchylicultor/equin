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
caller (the supervised `worktree.prepare` job, `conversations/workspace/worktree`)
refills the pool after a run that made a checkout. The refill job, its boot
warm-up and its daily cron live in the `spare-pool` sub-plugin — this plugin
stays job-free, because the CLI imports it.

A caller that only WAITS for a checkout made elsewhere reads
`checkoutState(repoRoot, path)` — `absent` | `unfinished` | `complete`, read-only,
never discarding (only the process making the checkout converges it). It
reads the files, not the install: only a `setupWorktree` that returned says a
checkout is locked and installed. Nothing in a backend installs a checkout —
`./equin install` spawned there is a child of the backend, and a restart
signals the backend's whole process group (see
`conversations/workspace/worktree`).

- **The lock reason is the readiness marker.** A spare is written
  (detached, sharing `addCheckout` with the cold path: one
  `checkout.workers=0`, one timeout, one partial-tree cleanup), **installed**
  (`installCheckout`, below), and only then locked with reason
  `SPARE_LOCK_REASON` (`LEGACY_IDS.spareLockReason`). `listReadySpares` lists only spares
  locked that way, so a half-written or uninstalled one is never claimed; a
  failed install leaves it unlocked for the prune. The lock also keeps
  Claude Code's own `.claude/worktrees` sweep away from it.
- **`spare-*` is non-canonical on purpose.** It fails `isCanonicalWorktreeName` (not an attempt id), so the
  reaper, the namespace passes and the registry filters ignore it. Do not widen
  the regex.
- **The claim** (inside the mutate-gate hold): `unlock` → move →
  `git switch [-c] claude-web/<id>` (a two-tree checkout: it writes only the diff
  since the spare's commit) → lock. Two claimers of one spare are told apart by
  the filesystem: the first `unlock` wins; the loser tries the next spare, then
  the cold add.
- **A lock is its file, not a git command.** `lockWorktree` / `unlockWorktree`
  create (`wx`) / unlink `.git/worktrees/<id>/locked`, the entry found by its
  `gitdir`. `git worktree lock` / `unlock` resolve their argument through the
  list of every worktree, reading each HEAD, and die ("failed to read
  …/commondir") on an admin dir a concurrent `git worktree add` is half-way
  through writing — the mutate gate admits three at once, so a claim's lock
  failed beside a spare refill and left the checkout unlocked.
- **An unlock is a `rename`, never an `unlink`.** `unlockWorktree` renames
  `locked` to a name only it knows, then deletes that. On macOS (APFS) two
  concurrent `unlink`s of one file both return success about half the time —
  across processes too — so an unlink-based unlock let both claimers of one
  spare move it (ENOENT on the second's `gitdir` rename). `rename`, `mkdir`
  and an `O_EXCL` create (`wx`) are exclusive; `unlink` and `rmdir` are not,
  so neither may decide a winner.
- **The list is its admin files, not a git command.** `listWorktreeEntries` /
  `listWorktreePaths` read `.git/HEAD` and each `.git/worktrees/<id>/{gitdir,
  HEAD, locked}` (one `rev-parse --git-common-dir` to find them): `git worktree
  list` dies the same way on a half-written entry, which failed the claim's
  spare lookup, `isUnfinishedCheckout`, the prune and `removeWorktree`'s
  registration check beside a refill. An entry without `gitdir` yet is passed
  over (as git does); one without `HEAD` yet is listed with `head: null`, its
  `initializing` lock still read — crash convergence depends on it. `head` is
  the HEAD file as written (a branch ref, unresolved, or a detached commit).
- **No git command here enumerates the worktrees.** `git worktree add`,
  `git worktree move` and `git switch <existing branch>` (its "already checked
  out" refusal) all read every worktree's HEAD first and die the same way —
  beside our own adds or anyone's (Claude Code's `agent-*` worktrees live in
  this repo too), so no lock of ours could exclude them all. So:
  - **`addCheckout` writes the admin entry itself** (`CheckoutHead`: detached,
    existing branch, or a new branch made create-only by `update-ref`): filled
    in a staging dir beside `.git/worktrees/` and renamed in whole — so no
    reader, git's included, sees it half-written — locked `initializing`
    (`ADD_IN_PROGRESS_LOCK`) from its first instant, exactly as git's add is;
    then the dir and its `.git` file, then `git reset --hard` (the child git's
    add runs) writes the tree, then the lock goes. A crash before the dir
    exists leaves a locked entry and no dir: the next add at that path discards
    it. The release checkout (`release/source-checkout`) uses it too.
  - **The claim's move is a rename + the admin `gitdir` rewrite** — `gitdir`
    first, so a crash between leaves a prunable entry the cold add discards
    (git's own order would leave the dir at the attempt's path with an entry
    naming the spare's, which nothing recognises).
  - **The claim's switch onto an existing branch** checks "checked out
    elsewhere" against our list, then passes `--ignore-other-worktrees`.
  The repo has no `post-checkout` hook and no `config.worktree` — the two
  things git's add does that `addCheckout` does not.
- **Nobody else runs them either** — the `worktree/no-raw-worktree-git` lint
  rule (`lint/`) rejects `git worktree list|add|move|lock|unlock|remove|repair`
  and a `git switch` without `--ignore-other-worktrees` / `--detach` / `-c`,
  as argv lists (`[GIT, …]`, `git(…)` helper arguments, a spread
  `...checkoutGit(dir)`) and as shell strings, everywhere but this plugin
  (its `exempt/index.ts`) and test code. A caller reads the list with
  `listWorktreeEntries` / `listWorktreePaths` / `ensureMainWorktreeRoot`.
- **Crash convergence.** A crash after the move leaves the dir in place on a
  detached HEAD — before the switch, or inside it. The early return recognises
  it by `isUnfinishedCheckout`: admin dir `spare-*` (the move keeps it), HEAD
  detached, and NO lock — a finished claim is always locked, so a working
  checkout on a detached HEAD (mid-rebase) is never touched. It **discards** the
  tree and checks the attempt out again (another spare, else the cold add); it
  never re-runs the switch in place: a switch killed mid-write leaves the files
  it added untracked under the old HEAD, which blocks any further switch
  (`--discard-changes` covers tracked changes only). The same check catches a
  cold add killed mid-checkout — its `initializing` lock
  (`ADD_IN_PROGRESS_LOCK`) still on it — whose discard releases that lock first.
- **Pruning.** `pruneSpares` removes `spare-*` dirs that are unregistered or
  unlocked and older than 15 minutes (newest of the dir's and its admin dir's
  mtime — an `unlock` touches the admin dir), and ready spares older than a day,
  taken by `unlock` first so a concurrent claim wins.

## Every checkout is installed (`server/internal/install-checkout.ts`)

`installCheckout(repoRoot, path, opts, signal?)` adopts a waiting dependency
store into a checkout that has no `node_modules` (below), then runs the checkout's OWN CLI, `<path>/equin
install`, with `EQUIN_FROZEN_LOCKFILE=1` (so creation never rewrites `bun.lock`),
background tier, output captured into the thrown error. Its own CLI because
`server` may not import `cli`, and the checkout's copy is the install code and
lock that belong to it. `createSpareIn` runs it before the lock (the installer is
a required parameter, so a test passes its own); `setupWorktree` runs it after
every path settles (fresh add, claimed spare — whose switch may move `bun.lock`
— and `existing`: a resume's checkout, or a retry whose install failed), outside the mutate
gate. Without it, a checkout's first program (the guard hook, not `./equin`)
resolved npm packages by walking up into main's `node_modules`.

## A removed checkout's dependency store goes to the next one (`server/internal/dep-store-pool.ts`)

A cold install clones each of ~1,100 package directories out of bun's cache, and
a directory `clonefile` holds the volume's rename lock while it runs — every
`rename` on the disk (main's `writeAtomic`) waits behind it: 0.2–1.9 s per
install, at any tier. It ran per launch, and the reap then deleted the same
75k-entry store. So the store is reused instead
(`research/2026-11-05-global-bulk-tree-mutations-rename-lock.md`):

- **Harvest** — `removeWorktree`, after the rename into the trash: the trashed
  checkout's `node_modules/.bun` moves to `.claude/worktree-dep-stores/<ms>-<name>/store`
  (staged, published by one rename), the newest 2 kept. Only when `ensureDeps`'
  stamp exists (the install finished) and no store entry is newer than it — a
  file edited in place is the one change bun's re-link would not undo.
- **Adopt** — `installCheckout`, before the install: a checkout with no
  `node_modules` takes the newest entry under 7 days old as its
  `node_modules/.bun`; the install (no stamp came with it) re-links it, cloning
  only what the lock changed.
- **An entry is only ever taken by renaming it to a claimed name**
  (`.claimed-…`) — by an adopter or by a delete (eviction past the newest 2,
  expiry). The rename is exclusive, so two adopters, or an adopter and a
  delete, are told apart by it, and an adopter can never move a store an
  `rm -rf` is half-way through.
- **Never fails a removal**: the harvest runs after the removal is committed,
  so its failure is a result (`HarvestResult.failed`), and the store is
  deleted with the checkout.
- **Results, not log lines**: `installCheckout`/`setupWorktree`/
  `createSpareWorktree` answer an `AdoptResult`, `removeWorktree` a
  `WorktreeRemoval`; the jobs log them on their channels with
  `describeAdoption` / `describeHarvest` (`worktree-prepare`,
  `worktree-spare-refill`, `worktree-cleanup`) — the count of cold installs
  and kept stores per day.
- **Only the store**: the top-level links, `.bin` and the workspace-local
  `node_modules` are links bun recreates, and bun never prunes a top-level
  entry the lock dropped — carrying them could keep a removed dependency
  resolvable.
- **Sweep** — `emptyWorktreeTrash` (the reaper's tick) deletes expired entries
  and transient names (`.staging-…`, `.claimed-…`) older than an hour — a
  process that died holding them.
- **Not caught**: a store file edited in place AND then a later successful
  install in the same checkout (the stamp is rewritten after the edit). Only
  content hashes would see it.

## Removal is a rename (`removeWorktree`)

Inside the mutate gate: unlock → `rename` the dir into `.claude/worktree-trash/<ms>-<name>`
(same volume: atomic, instant) → `git worktree prune`. Outside the gate: the
dependency store's harvest (above), then a background-tier `rm -rf` of the
trash entry. The branch ref is kept.

It used to be `git worktree remove --force` under a 300 s kill, holding a slot
while it deleted file by file. A kill left a half-deleted checkout in place, which
read as dirty, so the reaper's clean path never took it again. A rename has no half
state. A trash delete that is killed or dies with its process is retried by
`emptyWorktreeTrash`, which the reaper calls each sweep for entries older than an
hour (younger ones may still be under their own removal's delete).

## Retired branches lose their reflog (`server/internal/retired-reflogs.ts`)

git's `--reflog` walk (every auto-gc's `pack-objects --all --reflog`, `prune`) re-reads
every shared reflog once per linked worktree, so it costs worktrees × reflogs: 324 × 10.6k
took a repack 7–10 min. `dropRetiredBranchReflogs()` drops the reflog of each attempt
branch (and its `refs/remotes/*/claude-web/*` twin) that is merged into main and checked out
nowhere. The refs stay. The worktree-cleanup sweep runs it hourly, which keeps the reflog
count bounded by the live checkouts. See
`research/2026-11-05-global-git-repack-reflog-walk.md`.

## Cancellation

`setupWorktree(id, path, compositionIds, signal?)`,
`removeWorktree(path, signal?)` and `withWorktreeMutateSlot(fn, signal?)` all take
an optional ambient `AbortSignal` — a job handler passes its `ctx.signal`.

This is the gate where cancellation matters most. A handler stuck inside the
`worktree-mutate` acquire, or inside a git child while holding one of
its three host-wide slots, is not stalling itself: it is stalling worktree
checkouts on every backend on the machine (the 2026-08-17 outage). Aborting such a
handler means nothing unless the abort reaches the wait, so the signal is forwarded
to BOTH the host pool (a pending acquire unwinds; an abort mid-body hands the slot
back immediately) and every git child underneath, which `spawnCaptured` kills on
abort before throwing `signal.reason`.

Two children are deliberately left unbound, and both for the same reason: the
`git worktree prune` after a killed `worktree add`, and the one after a
removal's rename into the trash. Each is the tail of an operation already committed to,
so cancelling it would trade a released flock for a partial checkout the next retry
mistakes for a finished one, or a leaked `.git/worktrees` entry. Their own timeouts
bound them instead.

## Op liveness markers (`server/internal/worktree-op.ts`)

`markWorktreeOpStart(slug, kind, opId)` publishes
`~/.equin/worktrees/<slug>/ops/<opId>.json` = `{v:2, kind, opId, pid,
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

Transition (until phase 5 of `research/2026-09-29-global-unified-op-status.md`):
legacy per-kind `ops/<kind>.json` markers from an older CLI are still read, with
pid liveness.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

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
    - `AdoptResult`
    - `CheckoutHead`
    - `CheckoutSource`
    - `CheckoutState`
    - `CompositionMarker`
    - `HarvestResult`
    - `NamespaceClaimant`
    - `NamespaceProbe`
    - `RetiredReflogSweep`
    - `WorktreeEntry`
    - `WorktreeHead`
    - `WorktreeOp`
    - `WorktreeOpInfo`
    - `WorktreeOpMarker`
    - `WorktreeRemoval`
    - `WorktreeSetup`
    - `WorktreeSpec`
  - Exports (values):
    - `addCheckout`
    - `appCheckoutOf`
    - `checkoutState`
    - `countReadySpares`
    - `createSpareWorktree`
    - `describeAdoption`
    - `describeHarvest`
    - `dropRetiredBranchReflogs`
    - `emptyWorktreeTrash`
    - `ensureMainWorktreeRoot`
    - `gitWorktreesDir`
    - `hasCompositionMarker`
    - `isCanonicalWorktreeName`
    - `isCanonicalWorktreePath`
    - `isCompositionMarkerPath`
    - `isWorktreeOpActive`
    - `listActiveWorktreeOps`
    - `listWorktreeEntries`
    - `listWorktreeOps`
    - `listWorktreePaths`
    - `loadCompositionMarker`
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
  - Imported by: 36 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `debug` ×9
    - `infra` ×7
    - `framework` ×4
    - `tasks` ×4
    - `conversations` ×3
    - `build` ×2
    - `stats` ×2
    - `backup/sources/databases`
    - `code-explorer`
    - `plugin-meta/plugin-health`
    - `release/source-checkout`
    - `review/plugin-changes`
- Exemptions:
  - Exempts itself from:
    - `worktree/no-raw-worktree-git` — `.` (sanctioned)
    - `boundaries/no-platform-api` — `server/internal/composition-namespace.ts`, `server/internal/dep-store-pool.ts`, `server/internal/install-checkout.ts`, `server/internal/spare-name.ts`, `server/internal/spare.ts`, `server/internal/spec.ts`, `server/internal/worktree-op.ts`, `server/internal/worktree.ts` (debt)
    - `user-path/no-unproven-claim` — `server/internal/worktree.ts` (sanctioned)
  - Exempted by: `infra/worktree` (0 debt)
- Core:
  - Exports (types):
    - `OpKind`
    - `OpKindMeta`
  - Exports (values):
    - `ATTEMPT_BRANCH_PREFIX`
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
