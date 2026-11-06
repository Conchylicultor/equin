# Build pipeline step 11: a no-change build and its checks, O(repo) work left

Track: wiki "Track: build pipeline" (`block-3e7bbe1c-…`). Numbers: "Build pipeline: measurements" (`block-9f438022-…`). Task: task-1793995489-ycwhoz. Previous step: `2026-11-06-global-build-pipeline-step10-no-change-build.md`. Input: `2026-10-29-global-type-check-tree-hash-follows-the-change.md` (the checks' tree hash).

## Context
After step 10 a W0 build is ~7.9 s on the quiet VM. The task lists four suspected O(repo) costs: the checks' tree hash (stated ~2–3 CPU-s per check), CLI start-up walks of `plugins/`, the backend's keep-running stat walk, and docs / browser-host coverage. Measure first, then fix by size.

## 1. Measured (host, this worktree, nothing changed, 2026-11-06)
A full `./equin build` (checks included) took 17.1 s wall. Its profile covers 14.1 s; the rest is CLI start-up before the clock.

| Part | Cost | Notes |
| --- | --- | --- |
| **Backend restart** | **4.4 s** | `Restart needed: a loaded module …/@parcel/watcher/build/Release/watcher.node changed`. `linkParcelWatcherAddon` (aec983b780, today) copies the addon on every build (stage + rename), so its ctime moves and the keep-check correctly sees a changed loaded module. Every build since aec983b780 restarts its backend. |
| **CLI start-up, per `./equin` process** | ~1.0 s wall (`--help`: user 0.5, sys 0.73) | `ensureDeps`' walk of `plugins/` is 0.47 s of it, almost all sys (8,307 dirs and 19.7k files today; its docblock measured 4,044 dirs at 126 ms). Paid by the build AND by its check child (CPU profile: 605 ms + 726 ms), and by every other command. |
| git, all 62 children of the build + check pass | 2.3 s wall summed, 0.8 s of it `read_directory` | Tree hash = refresh 0.04 + `add -A` 0.26–0.8 (a full untracked walk, 8,678 dirs) + write-tree 0.02 + `ls-tree -r` 0.07. The build's two `status` calls (`loadRepoSnapshot`) are 0.56 s, the walk again. |
| keep-check (`ask the backend to adopt`) | 0.1 s | Small on the host since step 10's memo: not worth a change. |
| docs / browser-host coverage / compose / module graph | 1.25 / 0.5 / 1.2 / 0.75 s | Whole-set work, but each is under the items above. Next step. |

**Why the untracked walk is always full:** `core.untrackedCache=true` is set, but no git command ever writes the cache back to the index. Every reader runs `GIT_OPTIONAL_LOCKS=0` (spawn's child-env), and `computeTreeHash` throws its scratch index away. On a scratch index whose cache was written once, `git status` drops 0.83 → 0.19 s. `add -A` never uses the cache (its directory flags differ from status').

**The tree hash is not ~2–3 CPU-s per check any more.** That figure predates 2026-11-04, when an absolute-path fix made the scratch index seed from the real one, and the refresh-publish change. Today it is ~0.4–0.9 s per check run, dominated by the walk.

## 2. Fixes, by size

### a. The addon link is idempotent (W0 −4.4 s on the host)
`linkParcelWatcherAddon` compares the built file with the installed one (bytes, ~1 MB) and writes nothing when they are equal. Same contract otherwise (stage + rename when it differs). This is the structural fix: a build that changes nothing writes nothing the keep-check reads.

### b. ensureDeps reads only the directories that changed
The stamp keeps, beside the inputs' `(mtimeMs, size)`, each walked directory's mtime. A fresh-check stats every recorded directory (no readdir) and re-lists only those whose mtime moved; a new subdirectory found there is walked whole. A new `package.json` always moves its directory's mtime, so the input set stays exact. An edited one is caught by the inputs' own stat, as today. Cost: O(dirs) `stat` instead of O(dirs) `readdir` + O(files) dirents. Measure it; this keeps the walk correct by construction (no git dependency in the pre-install closure).

### c. The tree hash and the build's view use git's untracked cache
* `computeTreeHash` replaces `update-index --refresh` with `git status` on its scratch index, run WITH optional locks (the scratch index is this process's own file). That refreshes the stat cache and writes the untracked cache into the scratch. When the scratch learned anything (bytes differ, or a racy entry), it is published to the real index (the existing compare-and-swap under `index.lock`). Every later `status` in this checkout then walks only the directories that changed: the build's `loadRepoSnapshot` and the next check.
* `add -A` is limited to the paths status names (`--pathspec-from-file`, literal): tracked changes, deletions, and untracked entries (files, or whole untracked dirs). With nothing changed, there is no `add` at all. Same tree by construction: status' list is exactly the set `add -A` would change. A failure of the scoped add (a path vanished between the two) falls back to the plain `add -A`.
* Tests: `tree-hash.test.ts` gains equivalence cases (edit, new file, new nested dir, delete, a tracked file replaced by a dir, nested repo / gitlink, ignored file, `.gitignore` edit): the hash equals a plain `add -A` on a fresh copy of the index.

### Not this step
* A change signal (git fsmonitor, one daemon per worktree, or a host-wide watcher answering git's fsmonitor hook): it would turn the remaining O(dirs) stats into O(changes). It is a host-wide design decision (daemon fleet, lifecycle), recorded on the track page for the user.
* The overlay's `ls-files --ignored` (only in `--skip-checks` builds and uncached type-check runs).
* The host-semaphore sweep (~1 s of `openSync` in the grant acquisition under load): the adaptive scheduler track's.
* docs, compose, module graph: next step, by size.

## Verification
* Tests: `./equin test plugins/framework/plugins/tooling/plugins/checks/core` (tree-hash), `plugins/framework/plugins/cli/plugins/bootstrap` (ensure-deps), the parcel-addon plugin.
* Host: two W0 builds in a row: no restart; `--help` timing before/after; git trace (`GIT_TRACE2_EVENT`) of a W0 build: `read_directory` total before/after.
* Quiet VM (`steps-build-pipeline.sh`): base vs branch, W0 with checks (the parcel restart and the check child show only there), W0 `--skip-checks`, CC; cold must not regress.

## Critical files
* `plugins/infra/plugins/file-watcher/plugins/parcel-addon/cli/internal/link-parcel-addon.ts`
* `plugins/framework/plugins/cli/plugins/bootstrap/cli/ensure-deps.ts`
* `plugins/framework/plugins/tooling/plugins/checks/core/tree-hash.ts` (+ test)

## Outcome (2026-11-06)
Landed (a), (b), (c), plus a fourth fix found while measuring the check pass: (d).

### d. A replayed grep goes through the grep index (found in the host trace)
After (a)–(c), a git trace of two no-change builds still showed 22 `git grep -l` over the WHOLE tree per build (~13 CPU-s, 0.2–2.9 s each), with every check cached. They came from the input-keyed checks' read-set validation: `validate` replays every recorded grep whose pathspec fingerprint moved (for `*.ts`, after any `.ts` edit), and `runner.ts` replayed it with a raw whole-tree `gitGrepList`, bypassing the host-wide per-blob grep index that the checks' own selections use. A hit does not re-record, so every later run replayed the same queries: every build paid them, not only the first after an edit. The replay now asks the run's grep index (same tree); only blobs no run has asked about are grepped.

### What changed
* `link-parcel-addon.ts`: writes nothing when the installed addon already has the built bytes.
* `bootstrap/cli/dir-listing.ts` (new) + `ensure-deps.ts`: the walk for dep inputs keeps each directory's listing (only the candidate names, `package.json` / `index.ts`) under its `ino:mtime:ctime` stamp in `node_modules/.equin-deps-dirs.json`, with the filter in the record (a different filter is no record) and never creating `node_modules` (review). A run stats every directory and re-lists only those whose stamp moved.
* `checks/core/tree-hash.ts`: `status` on the scratch index (written, through the new spawn option `privateIndexWrites`) replaces `update-index --refresh`; what it learns (stats and the untracked cache) is published to the real index; `add -A` is scoped to the paths status named.
* `checks/core/runner.ts`: read-set grep replay through the grep index.

### Measured
**Host (loaded), this worktree, nothing changed, full `./equin build` with checks:** 17.1 s → 12.3–13.2 s after (a)–(c) → **9.9–10.0 s** after (d). The check pass 2.6–4.6 → 1.5 s. Git children of the whole build: 2.3 s wall summed (0.8 s `read_directory`) → 1.8 s (0.26 s), and no `git grep`. `./equin --help`: 1.02 s (sys 0.73) → 0.48–0.51 s (sys 0.27). `computeTreeHash` alone: 1.18–1.24 → 0.50–0.58 s, same hash. A plain `git status` in the checkout: 0.83 → 0.20 s (the published untracked cache).

**Quiet VM (6 cores / 12 GB), base `2c9def98d4` and the branch in two worktrees of ONE VM, alternating (s):**

| | Base | Branch |
| --- | --- | --- |
| W0, full build with checks | 9.07 / 8.99 / 9.43 | **7.21 / 7.19 / 7.28** |
| … backend | restarted every build (`watcher.node` changed), 1.7–2.5 s | kept |
| … up to `checks ✓` | 6.9–7.0 | 6.4 |
| … check pass | 1.7 | 1.4 |
| W0 `--skip-checks` | 10.38 / 9.58 / 9.50 | **7.86 / 7.74 / 7.62** |
| `./equin check` alone, unchanged tree (first, then 2 more) | 3.09, 1.49, 1.49 | **1.47, 1.22, 1.22** |
| C1 cold hermetic build (empty stores, OS cache warm), 2 pairs | 271.9 / 267.8 | 272.7 / 266.6 |
| … "Generating plugin registry" → "Running checks" | 12.0 / 11.4 | 15.1 (first after the VM resumed: cold OS cache) / 11.5 |

The VM's warm numbers predate (d) and the review fixes: (d) shows only where the read-sets were recorded at another tree (every agent build after an edit, and the host here), not in the VM's freshly primed worktrees.

### Not done, recorded
* A change signal for the remaining O(dirs) stats (git's untracked cache and `ensureDeps` both stat every directory, ~40–200 ms each): git fsmonitor (one daemon per worktree, ~219 on the host) or one host-wide watcher answering git's fsmonitor hook. A host-wide design decision for the user.
* The overlay's `ls-files --ignored` (0.23 s, `--skip-checks` builds and uncached type-check runs): `--ignored` disables the untracked cache.
* The host-semaphore sweep (~1 s of `openSync` in the grant acquisition under load, the adaptive scheduler track's), `pg`'s first `Date` bind (0.45 s of `getTimezoneOffset` in one process), docs 1.25 s, compose 1.17 s, the module graph 0.75 s.
