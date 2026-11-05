# `git repack --all --reflog` running 7–10 min: reflogs × worktrees

Task: task-1793840019-acc2t6 (from the supervisor audit task-1793826400-nd8if7, after
task-1793832103-6s0uii's file-op stall write-up).

## What triggers it

Nothing of ours. No code in the repo runs `gc`, `repack`, `prune` or `maintenance`. No
`maintenance.*` / `gc.*` config, no launchd or cron entry. It is git's own auto-maintenance:
`commit`, `merge`, `rebase`, `fetch` and `am` end with `git maintenance run --auto`, whose
only default task is `gc --auto`. That task detaches and runs `repack -d -l` when it
estimates more than `gc.auto` = 6700 loose objects (from `objects/17/`), or `repack -A` with
cruft when there are more than 50 packs. Either way `repack` runs
`pack-objects --all --reflog --indexed-objects`.

Loose objects come from ordinary work in the shared object store: commits, stashes, and
`add`/`write-tree` across ~300 checkouts. On 2026-11-04/05 the rate was 600–1,800 loose
objects an hour (5,886 loose: 4,542 trees, 1,219 blobs, 125 commits). That puts the
threshold some hours apart. The cadence is normal git behaviour; the cost per run is not.

Frequency is not recorded anywhere: git leaves no trace of a successful auto-gc, and the
fs-latency monitor names the process only as `git`. Pack mtimes date one run, a 102 MB pack
written 2026-11-05 01:40 local after a 10+ min run (the audit's observation).

## Why one run costs 7–10 minutes

Split of the walk, at agent (darwinbg) priority, on the real repo (324 worktrees, 10,612
reflogs, 10,580 packed refs):

| walk | time |
| --- | --- |
| `rev-list main` | 0.1 s |
| `rev-list --all` (every ref, no reflogs) | 14.6 s |
| `rev-list --all --reflog` | **416 s** |
| `rev-list --reflog --no-walk` (reflog tips only, no history) | **519 s** |

Nearly all of it is reading reflogs, not walking history. `sample`: 100% in
`add_reflogs_to_pending → refs_for_each_reflog → handle_one_reflog →
files_for_each_reflog_ent → read`, under `merge_ref_iterator_advance`.

**Mechanism.** `revision.c`'s `add_reflogs_to_pending` iterates the main ref store's
reflogs, then each linked worktree's ref store. A worktree store's reflog iterator merges
the worktree's own `logs/` with the common `logs/`, so every shared reflog is opened and
read again once per worktree. `reflog expire --all` de-duplicates shared refs across
worktrees; the revision walk does not. So one walk is O(worktrees × shared reflogs).

Reproduced in a scratch repo with 400 branch reflogs:

| worktrees | reflog walk |
| --- | --- |
| 0 | 0.05 s |
| 40 | 0.66 s |
| 160 | 2.59 s |
| 160, half the reflogs dropped | 1.35 s |

On the host: 324 × 10,612 ≈ **3.4 M reflog file opens per walk**. A repack does this walk
in `pack-objects`, and `gc` again for `prune`'s reachability. It does so under the
host-wide file-op pressure (vnode recycling, darwinbg I/O throttling) that
task-1793832103-6s0uii measured, which is why each open costs ~0.1 ms rather than µs.

## Why there are 10.6 k reflogs

`core.logAllRefUpdates=true` gives every ref a reflog. Every attempt gets
`refs/heads/claude-web/<id>` (5,956 reflogs). Every `./equin push` writes
`refs/remotes/origin/claude-web/<id>` (4,622). Neither is ever cleaned up.
`removeWorktree` keeps the branch on purpose (it is the last trace of a reaped attempt's
commits). All 5,968 local attempt branches and 4,627 remote-tracking ones are already
merged into main, and only ~320 are checked out.

## Fix

Keep every ref. Drop the **reflog** of an attempt branch, and of its remote-tracking ref,
once both of these hold:

- it is merged into main;
- no worktree has it checked out.

At that point everything the reflog records is either in main's history or a pre-rebase
draft of work that landed. `infra/worktree`'s `dropRetiredBranchReflogs` does this, and the
hourly `worktree-cleanup.reap-stale` sweep runs it after its checkout pass. The shared
reflog count is then bounded by the live checkouts (~2 per checkout) instead of growing
with every attempt ever run. The first sweep drops ~10 k reflogs.

Not changed: worktree retention (the other factor), refs, unmerged branches' reflogs,
gc/maintenance config. Lowering `gc.auto` frequency would hide the cost, not remove it.

Remaining factor: the walk is still O(worktrees × live reflogs), ~324 × ~650 ≈ 0.2 M
opens, about 16× less. Removing the per-worktree re-read of shared reflogs is upstream
git's (`add_reflogs_to_pending` could skip shared refs for non-current worktrees, as
`reflog expire` already does).

## Before / after

See the task's outcome report for the measured after-numbers (taken after main's first
sweep with the fix).
