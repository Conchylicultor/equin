# source-checkout

The private checkout a release of committed code builds from.

`./singularity release` used to build from whatever checkout it was run in. A
release takes minutes; a `./singularity push` fast-forwards main's checkout in
seconds. When one landed during the other's type-check, tsc read files from two
commits and failed on errors neither commit had (deploy run
`drun-1789637806775-hkg0kq`). Worse than a failed build would have been a build
that passed: a bundle mixing two commits, shipped to a remote host, labelled with
one sha. This plugin gives a release a tree nothing else can move.

## The three calls

- **`acquireReleaseCheckout({ sourceRoot, sha, name })`** → `{ name, root, dispose() }`.
  Sweeps leaked checkouts, takes this checkout's lock, runs
  `git worktree add --detach <dir>/<name> <sha>` under the host-wide
  `worktree-mutate` slot, asserts `HEAD` really is `sha`, and runs a best-effort
  `mise trust`. `name` is the release run id: unique by construction, and a valid
  namespace label, because the checkout's basename becomes the scratch namespace
  the inner build files its artifacts under.
- **`dispose()`** removes the checkout (`git worktree remove --force`, or a plain
  `rm` once git no longer knows the dir), prunes git's registration, removes the
  scratch namespace's data dir (`worktrees/<name>/`: the release web dist and
  check transcripts), then drops the lock. Idempotent.
- **`sweepLeakedReleaseCheckouts(repoRoot)`** removes every checkout whose lock
  it can take. Per-entry failures are returned, never thrown.
- **`isReleaseCheckout(root)`** — a direct child of the checkouts dir. The release
  CLI asks it of its own root to recognise the inner build.

## Leak cleanup is a kernel lock, not a schedule

Each checkout `<dir>/<run-id>/` has a sibling `<run-id>.lock`, and the owning
release process holds an exclusive `flock` on it (`packages/flock`) for the
checkout's whole life. The kernel drops that lock when the process dies —
SIGKILL and OOM included — so "can I take this lock?" is exactly "is its owner
gone?", with no pid to go stale. Every acquire sweeps first, so a leaked
checkout costs disk only until the next release. Nothing polls.

Two details that look fussy and are not:

- **The lock file IS unlinked, unlike the CLI's checkout locks.** A release lock
  file names a one-off run id, so keeping them would grow the dir by one file per
  release forever. It is unlinked only by a process that holds the lock, and a
  won flock only counts if the path still names the inode that was locked
  (`tryTakeLock`). That closes the race where a sweep unlinks a lock file between
  an acquirer's `open` and its `flock`: the acquirer sees the inode mismatch and
  retries on a fresh file instead of holding a lock nobody else can see.
- **The lock is taken before the checkout exists, and the sweep keys on lock
  files as well as dirs.** A lock file with no dir is an acquire that died before
  `worktree add`, or a dispose that died after removing the tree; both are swept.

## Why a detached `git worktree`, and not a branch or a clone

- **No branch:** a release checkout holds no work, so there is nothing to
  converge to on retry and nothing to push.
- **No namespace probe, no `git worktree lock`:** it serves no namespace, and it
  lives outside `.claude/worktrees/` — the directory Claude Code sweeps, and the
  only one `worktree-cleanup` reaps. So the reaper never sees it, which is
  intended.
- **Not a clone:** `worktree add` shares the object store, so creating one costs
  a checkout of the files, not a fetch.

The removal path guard (`assertReleaseCheckoutPath`) sits at the destructive
call: a path that is not a direct child of the checkouts dir is refused before
anything is removed — the counterpart of `infra/worktree`'s
`isCanonicalWorktreePath`.

## Data dirs

- `cache/release-checkouts` — `reclaim: restart`, not `safe`: deleting a checkout
  under a running release fails that release. Once no release runs, everything
  in it is reclaimable, which is what the sweep does.
- `cache/release-cargo-target` — the shared cargo `target/` for a release's
  `tauri build`. A fresh checkout's own `tauri/src-tauri/target` would compile the
  Rust shell cold every time. Cargo's own file lock serializes two builds over
  it; two concurrent *desktop* releases can still copy each other's
  `release/bundle` output between one's build and its copy — an accepted gap, as
  concurrent tauri releases on one host are not a workflow today.

## Known gaps

- The scratch namespace dir is removed on dispose, so the "Details:" path a
  stalled check prints during the release points at a file that is gone
  afterwards. The transcript already carries the output.
- The entry `mise trust` adds to mise's trust store for each checkout is never removed.
- `server/` must stay DB-free: `./singularity release` imports it. Check the
  transitive closure before adding an import (see `bundles/CLAUDE.md`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The private, detached git checkout a release of committed code builds from: acquire one pinned to a commit (held by a kernel flock for the owning process's life), dispose of it, and sweep the checkouts whose owner died. DB-free so the release CLI can import it.
- Server:
  - Uses:
    - `infra/paths.GIT`
    - `infra/paths.worktreeDataDir`
    - `infra/worktree.withWorktreeMutateSlot`
    - `infra/worktree.WorktreeGitTimeoutError`
  - Exports (types):
    - `ReleaseCheckout`
    - `SweepResult`
  - Exports (values):
    - `acquireReleaseCheckout`
    - `isReleaseCheckout`
    - `releaseCargoTargetDir`
    - `sweepLeakedReleaseCheckouts`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/source-checkout.ts` (debt)

<!-- AUTOGENERATED:END -->
