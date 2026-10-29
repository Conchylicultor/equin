# Type-check: the tree hash follows the change (step 3f)

> **Status (2026-10-29): measured, deferred, not built.** About 2–3 CPU-s per check (~12 CPU-min a
> day across the host) is under 1 % of a build. The work moved to the build pipeline track's
> [Snapshot] item (one git-derived snapshot per build, read by the checks as their tree hash). Its
> findings below (the throwaway scratch index, `--ignored` disabling the untracked cache, ~219
> per-worktree fsmonitor daemons, the cold first run in a fresh worktree) are inputs to that design.

Task: task-1793226360-6doqmm. Track: "Track: build and push speed" (block-e5afc5b1-…), design
sub-page "Rung 2 design" (block-a9e68ab6-…), after "Step 3e result".

## Context

After step 3e, an unchanged-tree `./equin check type-check --jobs 1` costs ~10.5 CPU-s end to end
while the worker costs 0.6. The step 3b table attributed what is left to the CLI floor (~2), git's
stat of every file for the tree hash (~1.5–2), prepare's tsconfig match (~0.5) and start-up — but
that leaves ~5 CPU-s unaccounted for, and nothing has measured how the git part grows with the repo.
The tree hash is not type-check's alone: `computeTreeHash`
(`plugins/framework/plugins/tooling/plugins/checks/core/tree-hash.ts`) keys **every** check run
(`check/cli/run.ts:302`, the runner's cache, the check single-flight), so its floor is paid by every
`check`, `build` and `push`.

What runs today on every check, whatever changed (read-only spot check, this worktree, 21,224
tracked files, 219 worktrees on the host, Apple git 2.50.1 with `fsmonitor--daemon` built in, no
`core.fsmonitor` / `core.untrackedCache` set):

| git call | where | CPU-s (user + sys) | what makes it O(repo) |
| --- | --- | --- | --- |
| `cp` real index → `/tmp` scratch (3 MB) | tree-hash.ts | ~0 | — |
| `update-index -q --refresh` | tree-hash.ts | 0.13 | lstat of every tracked file |
| `add -A` | tree-hash.ts | 0.7–1.0 (mostly sys) | readdir of every directory for untracked files + lstat of every file |
| `write-tree` | tree-hash.ts | 0.04 | — (cache-tree) |
| `ls-files -o -i --exclude-standard --directory` | type-check `repo-view.ts:422` (overlay) | ~1.0 (sys) | the same untracked/ignored directory walk again |
| `ls-tree -r -z <tree>` + parse | `checks/core/read-set.ts:173` | not measured | one record per file |

Two structural flaws, beyond "git stats everything":

1. **The scratch index is thrown away.** Each run copies the *real* index, whose stat cache, untracked
   cache and (if enabled) fsmonitor token are only as fresh as the last `git status` someone ran.
   Even with fsmonitor on, a token from an index nobody advanced makes the daemon answer "everything
   may have changed" → full scan. So fsmonitor alone cannot help the current code: the hash's own
   index has to persist.
2. **The directory walk is paid twice** (`add -A` for untracked, the overlay's `ls-files --ignored`),
   and `--ignored` disables git's untracked cache, so the overlay stays O(repo) even with fsmonitor.

## Approach

Measure first (M1–M3), then make the git part O(changes) (F1–F3) behind gates the measurements
decide. Report in the sub-page as "Step 3f result" with before/after tables; update the track page.

### M1 — where the ~10.5 CPU-s go now (unchanged tree, hub body edit)

- Run `./equin check type-check --jobs 1` (check cache deleted, isolated `EQUIN_DIR` stores as in 3e)
  with `GIT_TRACE2_EVENT=<file>`: every git child's argv, wall, and its regions (`refresh`,
  `read_directory`, `untracked cache`, `fsmonitor`) — no code change needed for the git part.
- Per-process CPU of the whole tree (CLI bun, prepare thread, worker, git children): `/usr/bin/time -l`
  on the command plus the existing progress-log phases (`progress.bootstrap("tree-hash")`, …) and the
  worker's own log line. Attribute every CPU-s to a row: CLI start/module load, tree hash, snapshot
  `ls-tree`, overlay `ls-files`, tsconfig match, prepare thread start, worker start, worker, finalize,
  op lifecycle (grant, op-log, banners). Close the ~5 CPU-s gap left by the 3b attribution.
- Probe: a script `type-check/scripts/floor-profile.ts` (run with `./equin run`) that parses the trace2
  file into the table, so the after-measurement is the same ruler.

### M2 — how the git part grows with the repo

- Synthetic repos in `/tmp` with this repo's shape (files per dir, dir depth, ignored `node_modules/`
  per plugin) at 1×, 2×, 4×, 8× (21k → 170k files). For each: refresh, `add -A`, `write-tree`,
  `ls-files -o -i --directory`, `ls-tree -r`, CPU and wall, cold (purged) and warm.
- Same matrix with (a) `core.untrackedCache=true` only, (b) `core.fsmonitor=true` + untracked cache,
  (c) (b) with a persistent scratch index — the only configuration where fsmonitor can work (flaw 1).
- Expected shape to confirm or refute: today linear in files + dirs; (a) linear in dirs only;
  (c) O(changes) after the first run.

### M3 — is git's fsmonitor viable on this host

Measured on scratch clones and two real worktrees, git flags passed per command
(`git -c core.fsmonitor=true -c core.untrackedCache=true …`), so no repo config is touched:

- **Correctness**: hash with (c) == hash without, over a scripted sequence — edit, create, delete,
  rename, mode change, new ignored file, `.gitignore` edit, nested new dir, a file changed within the
  same second (racy-git), branch switch/rebase under the persistent index, daemon killed mid-sequence,
  worktree moved.
- **Daemon cost**: RSS, FDs, idle CPU per daemon; first-call (cold daemon) cost; FSEvents behaviour
  with 219 worktrees (one daemon each, auto-started by git and never idle-exiting); what happens when a
  worktree is deleted (does the daemon exit, or leak?). The sidequests/monitors FD-leak history makes
  this a hard gate, not a footnote.
- **Gate**: fsmonitor ships only if (c) is correct on every case and the daemon fleet cost is bounded
  (daemon exits with its worktree, ≤ a few MB / ~0 idle CPU each). If daemons-per-worktree is not
  acceptable, the fallback is F1 + untracked cache only (O(dirs), no daemon), and one host-wide change
  source (a single FSEvents stream answering git's fsmonitor hook protocol v2) is filed as its own
  task rather than built here.

### F1 — a persistent per-worktree hash index (needed by any change signal)

- `computeTreeHash` keeps its scratch index at `$(git rev-parse --git-path equin-tree-hash.index)`
  (per worktree, inside git's dir, never the real index). Each run: copy it (or seed from the real
  index when absent) to a per-process temp file, `update-index --refresh` / `add -A` / `write-tree`
  on the copy, then atomically `rename` it back. Concurrent runs on one worktree each work on their own
  copy; last rename wins, and every candidate is a valid index for that worktree — no lock needed.
- Its stat cache, cache-tree, untracked cache and fsmonitor token now advance run to run, so a
  run pays for what changed since the previous run, not since the last `git status`.
- Fail-open contract of `computeTreeHash` (null → uncached) kept as is.

### F2 — enable git's change signal for the hash's git calls only

- Pass `-c core.untrackedCache=true` (and, if M3's gate passes, `-c core.fsmonitor=true`) on the
  tree-hash git calls, not in repo config: what the agent's own `git status` does is unchanged, and
  turning it off is one line. Config of the flags lives in `tree-hash.ts` as data.
- If fsmonitor ships: daemon lifecycle owned explicitly — stop it (`git fsmonitor--daemon stop`) where
  a worktree is torn down (find the worktree-removal path; it is outside this plugin), and count live
  daemons in the health report only if M3 shows they can outlive their worktree.

### F3 — the overlay stops re-walking the tree

The overlay needs only the gitignored files the tsconfig `include` makes roots of (a dozen
`*.composition.*.generated.ts` registries). Options, picked by M1/M2 numbers:

- (preferred) take the ignored entries from the same index run: `add -A` already walks for untracked
  files; with untracked cache the walk is cached — but `--ignored` disables it, so instead list ignored
  files **only under the include's directories that can hold an ignored root**, via a pathspec derived
  from the tsconfig `include` (bounded by the include's static prefixes), or
- declare the overlay set as data owned by the registry codegen (the generator knows every file it
  writes), so the check reads N known paths, O(overlay) — the highest rung if the pathspec walk is
  still O(plugins/).

Whichever it is, `repo-view.ts`'s assertion that every overlay file is a tsconfig root stays.

### Out of scope (recorded, measured in M1, filed if large)

- The CLI floor (~2 CPU-s): module load and op lifecycle; M1 attributes it, a follow-up fixes it.
- `ls-tree -r` of the whole tree per run (`read-set.ts`) if M1 shows it material: diff against the
  previous tree instead (`git diff-tree` from the run base's tree) — O(changes).
- web-artifacts' `global-css.ts` does its own `ls-files` + stat sweep (~0.5 s) per build: same
  class, switch to `computeTreeHash`'s index once F1 exists.

## Critical files

- `plugins/framework/plugins/tooling/plugins/checks/core/tree-hash.ts` — F1, F2.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/shared/repo-view.ts`
  (`listIgnored`, overlay) — F3.
- `plugins/framework/plugins/tooling/plugins/checks/core/read-set.ts` (`loadTreeSnapshot`) — M1 only.
- `plugins/framework/plugins/cli/plugins/check/cli/run.ts` — caller; unchanged.
- New: `type-check/scripts/floor-profile.ts` (M1 ruler), a tree-hash correctness test
  (`checks/core/tree-hash.test.ts`: scripted edits in a temp repo, persistent vs fresh index equal).

## Verification

- `tree-hash.test.ts`: every M3 correctness case, hash with persistent index (+ untracked cache,
  + fsmonitor when enabled) equals a fresh-index hash; concurrent runs on one worktree.
- `./equin test plugins/framework/plugins/tooling/plugins/checks` and the type-check plugin's tests;
  `./equin check`; `./equin build` green.
- Before/after with the M1 ruler, same host session, isolated stores: unchanged tree, hub body edit,
  one new untracked file, `.gitignore` edit; plus M2's growth table after the change.
- Exit for this step: the git part of an unchanged-tree check no longer grows with the repo (flat in
  M2's 1×→8× series), and the end-to-end table names every CPU-s of the remaining floor.
