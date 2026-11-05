# Bulk tree mutations and the volume rename lock: who holds it, and how to stop

Task: task-1793837725-vv8ch3 (filed by task-1793832103-6s0uii; its write-up is
`research/2026-11-05-global-host-file-op-stalls.md`, §2). Supervisor audit:
task-1793826400-nd8if7.

**Measured** and **inferred** are kept apart. No root, so no kernel stacks.

## The question

6s0uii measured renames on the Data volume being serialized while a process
mutates a directory tree in bulk. A disjoint-dir rename was held 0.3–1.3 s during
a `bun install` or an `rm -rf node_modules`. Its working hypothesis was that the
throttle stretched each hold: the holders run darwinbg (IOPOL_THROTTLE), the
waiters are main's `renameSync ← writeAtomic` and `cloneNamedBinary` (10
event-loop stalls of 3.3–13 s over 10-31 … 11-04, ~2 a day).

This task asked two things:
- who runs these mutations, and why so often?
- should a lock-holding mutation run throttled at all?

## Inventory (measured, main's DB `supervised_job_runs` + the job log channels)

| per day (11-04, a busy day; 10-30 … 11-03 in brackets) | runs | what it writes |
| --- | --- | --- |
| `worktree.spare-refill`: spares written | 57 (25–41) | full checkout (22k files) **+ cold install** (75k-entry store) |
| `worktree.prepare`: cold adds (no ready spare) | 42 (6–15) | full checkout **+ cold install** |
| `worktree.prepare`: spare claims | 57 (25–41) | a diff checkout + incremental install |
| `worktree-cleanup.reap-stale`: checkouts reaped | 67 (24–78) | `rm -rf` of the whole checkout, its 75k-entry store included |

Job wall time on 11-04: refill 9,347 s, prepare 12,065 s, reap 5,059 s, all of it
darwinbg children. So about 100 cold installs and 67 store deletions a day. Each
launch costs one cold install, and each reap deletes the same store again.

Agents' own installs are not the problem: `ensureDeps` is stamp-gated (~140 ms
when fresh), and a build/check installs inside its host grant, which lifts it out
of darwinbg.

## What holds the lock (measured, 2026-11-05, this host, load 15–40)

The method:
- a foreground probe renamed one file back and forth in its own dir at 10 Hz;
- meanwhile one candidate ran, in a scratch copy of the repo (warm bun cache).

Stats are of the probe's renames inside each window.

| candidate | wall | probe rename max | > 250 ms |
| --- | --- | --- | --- |
| `bun install`, default backend (`clonefile`), darwinbg | 7.0 s | 232 ms | 0 |
| same, foreground | 13.6 s | **1,917 ms** | 5 |
| same, foreground, 3 more runs | 2.3 / 4.2 / 10.0 s | 183 / 291 / 542 ms | 0 / 1 / 1 |
| `--backend=clonefile_each_dir`, 3 runs | 10.2–10.5 s | 15–26 ms | 0 |
| `--backend=hardlink`, 3 runs | 20–30 s | 10–32 ms | 0 |
| `--backend=copyfile`, 3 runs | 9–13 s | 1–8 ms | 0 |
| `git reset --hard` into an empty work tree (fg / darwinbg, 2 runs each) | 3.4–14.9 s | 0.3–25 ms | 0 |
| `rm -rf` of every `node_modules` (12 runs, all backends) | 5–21 s | 4–47 ms | 0 |
| `rm -rf` of a checkout without `node_modules`, darwinbg | 24.6 s | 374 ms (1 of 4 runs) | 1 |
| a real `./equin install`, cold, fg / darwinbg | 4.7 / 4.8 s | 237 / 129 ms | 0 |
| a real `./equin install` over an **adopted store** (below) | 0.9 s | 0.2 ms | 0 |

- **Measured.** The one consistent holder is bun's default install backend. Every
  run held a disjoint-dir rename, at either tier. No other backend held one: they
  do the same writes, but file by file. The git checkout held nothing. `rm -rf`
  of `node_modules` held nothing in 12 runs, and one of 4 checkout deletes held
  374 ms.
- **Inferred.** bun's `clonefile` backend `clonefileat(2)`s each package
  *directory* out of `~/.bun/install/cache` (1,106 of them). A directory clone
  holds the mount's rename lock while it copies the hierarchy, which matches
  6s0uii's synthetic finding that cross-parent directory moves held it and file
  ops did not. The longest single package clone sets the probe's max. darwinbg
  stretches the whole install under I/O contention (80–90 s in 6s0uii's run
  against 5–11 s), so it multiplies how many such holds land in a busy hour, but
  it is not what makes them holds.
- **Measured.** In bun 1.4.4, `clonefile_each_dir` is not CoW. One install with
  it consumed 1.48 GB, and its files sit at different physical offsets from the
  cache (`F_LOG2PHYS`). `hardlink` shares inodes with the global cache, so a
  dependency edited in place would change every checkout. `copyfile` is 1.4 GB
  per checkout. **None of them is an acceptable default.**

So, the tier question: **no, the throttle is not the lever.** A foreground
install held the lock longest (1.9 s). The hold comes from what the install is,
and the fix is not doing a cold install ~100 times a day.

## Why the work happens: the store is thrown away and rebuilt

A checkout is created (spare or cold add), cold-installed, worked in, and reaped
days later with `rm -rf`. The next checkout then clones the same ~1,100 packages
again. Its lock differs from the reaped one by a handful of packages.

**Measured, with the isolated linker.** All bytes live in the store
(`node_modules/.bun/<name>@<version>[+hash]/`, 1,106 dirs, 75k entries).
Everything else in `node_modules` is links: the top level, `.bin`, and the 92
workspace-local `node_modules`.

The reuse experiment:
1. Install a store from the lock of 2026-10-31 (`3f45245`).
2. Move its `.bun` into a fresh checkout of HEAD, delete everything else, and
   plant a stale link inside one entry.
3. Run `bun install`.

The result:
- **1 package installed, 0.7 s.**
- The stale link was repaired.
- The tree equals a clean install of HEAD entry for entry: 5,145 package dirs
  and links, same versions and targets.

**Measured, and the reason only the store moves.** bun never prunes a top-level
entry the lock no longer names (a planted `node_modules/zz-extraneous` survived).
So carrying over the top level could keep a removed dependency resolvable. A
store entry nothing links to is inert.

**Measured, and the one hazard.** bun trusts an existing `<name>@<version>` dir's
contents. A file edited in place (a debugging patch) would be handed on. A real
install's store files all predate its stamp (`node_modules/.equin-deps`, written
after the install succeeds): 9 of 9 sampled live checkouts had no store entry
newer than it (75k lstats, 3.5–6 s read-only).

## The fix: a removed checkout's store goes to the next checkout

`infra/worktree` `server/internal/dep-store-pool.ts`:

- **Harvest** (`removeWorktree`, after the rename into the trash, outside the
  mutate gate):
  - **Guards.** A store moves to `.claude/worktree-dep-stores/<ms>-<name>/store`
    only if the stamp exists and no store entry is newer than it. Otherwise it is
    deleted with the checkout, as before.
  - **Publish.** The entry is staged, then published by one rename.
  - **Bound.** The newest 2 wait; any beyond are deleted.
- **Adopt** (`installCheckout`, before `./equin install`):
  - A checkout with no `node_modules` takes the newest entry younger than 7 days,
    by renaming its store to `node_modules/.bun`. No stamp comes with it, so the
    install always runs and re-links it.
  - An entry is taken (by an adopter, or by a delete: eviction, expiry) only by
    renaming it to a `.claimed-…` name. The rename is exclusive, so an adopter
    can never move a store a delete is half-way through. The loser gets ENOENT
    and tries the next entry.
  - A checkout that already has `node_modules` (a claimed spare, a resume) is left
    alone.
- **Sweep** (`emptyWorktreeTrash`, each reaper tick): expired entries, and
  transient names a dead process left (over an hour old).
- **Failure.** A harvest never fails the removal it follows. The removal is
  already committed, so a failure is a result (`failed`), and the store is
  deleted with the checkout as before.
- **Residual hole.** A store file edited in place, followed by a later
  successful install in the same checkout, passes: that install rewrites the
  stamp after the edit. Only content hashes would catch it.

Supply and demand: removals (~67 a day) run below creations (~100), so nearly
every removed store is adopted. Creations beyond the supply stay cold installs:
the first launches after a quiet period, and any launch while the pool is empty.

Not changed, and why:
- **The tier.** The data does not support lifting the install out of darwinbg.
- **bun's backend.** Every alternative costs 1.4 GB per checkout or shares
  mutable inodes.

## Before → after

Before, per the inventory: ~100 cold installs and ~67 `node_modules` deletions a
day. Event-loop stalls with top frame `renameSync`: 10 over 5 days (8
`writeAtomic`, 2 `cloneNamedBinary`; 3.3–13 s).

The fs-latency monitor's rename probe (added by 6s0uii) had 43 min of data at
this point. Its one tick over 250 ms (447 ms, 01:13Z) was one of this
investigation's own scratch `clonefile` installs, so the `rename-stall` rule had
not fired yet.

After: the counts come from the log lines this change adds, on the channels of
the jobs that run it:
- `worktree-spare-refill` (`wrote a ready spare; …`) and `worktree-prepare`
  (`checkout <id>: <source>; …`): `dependency store adopted from …` vs
  `no dependency store waiting — cold install`;
- `worktree-cleanup` (`reaped <id>; …`): `dependency store kept for the next
  checkout` vs `… deleted with the checkout — <why>`.

Then compare a day of the `renameSync` stall family and the monitor's ticks over
250 ms against the numbers above. See the outcome report of
task-1793837725-vv8ch3 for what had landed by the time it closed.

## Left open

- **The cold installs that remain.** A launch while the pool is empty still holds
  the lock. Making them rare is this change; making them harmless would need
  bun's directory clone not to hold the rename lock (upstream), or an install
  that clones per file without copying.
- **The checkout's own `rm -rf`.** The repo files and build outputs, without the
  store, held 374 ms once in 4 runs. Not attributed further.
- **main's sync `renameSync` on its event loop** (`writeAtomic`). Any hold anywhere
  freezes main for its length. That is the waiting side, deliberately not touched
  here.
