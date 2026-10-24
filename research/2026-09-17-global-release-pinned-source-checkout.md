# Releases build from a pinned private checkout

## Context

Deploy run `drun-1789637806775-hkg0kq` (`update website`) failed its build leg.
Its release, `release-1789637820602-toe2lm`, built from main's live checkout:
`release-job.ts` spawns `./equin release` with `cwd: REPO_ROOT`, and
`release/cli/run.ts` builds from `root = REPO_ROOT`. While its type-check ran,
`./equin push` fast-forwarded that same checkout from `dba1997e3` to
`3e02098cd`. So tsc read a mix of both commits and failed on errors neither
commit has (`hasRuntimeNamespace` missing; deleted `query-deadline.ts` "not found").

Push holds only the push lock, and a release holds only the per-checkout
`.build.lock`, so nothing stops the tree from changing mid-release. Main's
regular build survives the same race only because a new build follows every
advance of main. A deploy is a one-shot run, and a mixed bundle on a remote box
would stay live until the next update.

**Outcome:** a release of committed code builds from its own detached checkout
of one commit. No push can change that tree, and the bundle's `commitSha` is
exactly what it contains (`commitDirty: false`).

All caches a release uses are already shared across checkouts, so a fresh
checkout starts warm:
- the tsc warm-base pool (`tooling/plugins/checks/core/warm-base.ts`), which is
  path-independent;
- the check cache (`checks/core/cache.ts`), keyed by content;
- the web-artifacts store, keyed by content;
- the natives cache (`stageNatives`), keyed by the dependency set;
- bun's package cache (installs by cloning files).

The one exception is tauri's cargo `target/` dir; see step 3.

## Decisions

- **Uncommitted changes** (user's choice): a non-main checkout with uncommitted
  changes builds in place, as it does today, and is marked dirty. Deploy already
  never treats a dirty bundle as current.
- **Main always pins.** It pins at `git rev-parse HEAD`, even if `git status`
  looks dirty. A status read taken while a push is writing files can look dirty,
  and falling back to an in-place build there would reopen exactly this race.
  Main never holds work that is meant to ship.
- **The CLI owns the checkout, not the job engine.** `./equin release`
  becomes a thin outer process: it pins the commit, creates the checkout, re-runs
  the release inside it, and removes it. So a hand-run release is protected too,
  and `release-job.ts`, `enqueueRelease` and the deploy workflow stay unchanged.
- **Leak cleanup uses a kernel lock, not a schedule.** The outer process holds a
  `flock` on the checkout for its whole life (`packages/flock`; the kernel drops
  it on SIGKILL). Every release starts by removing any checkout whose lock it can
  take, meaning its owner is dead. A leaked checkout costs only disk until the
  next release, and its dir is declared reclaimable.

## Design

### 1. New sub-plugin `plugins/release/plugins/source-checkout` (server barrel; the CLI already imports release server barrels)

- `data-dirs/index.ts`, declared with `defineDataDir` (pattern:
  `release/plugins/bundles/data-dirs`, `tooling/plugins/checks/data-dirs`):
  - `releaseCheckoutsDir`: `kind: "cache"`, `reclaim: { kind: "safe" }`.
  - `releaseCargoTargetDir`: `kind: "cache"`, the shared cargo target dir for tauri.
- `acquireReleaseCheckout({ sourceRoot, sha, name })` returns
  `{ root, dispose() }`:
  1. `sweepLeakedReleaseCheckouts()`.
  2. `flockTry(<dir>/<name>.lock)`; it must succeed, since the name is unique.
  3. `git -C <mainRoot> worktree add --detach <dir>/<name> <sha>`, inside
     `withWorktreeMutateSlot` (`infra/worktree/server`). Use `spawnCaptured`
     with a named timeout, and clean up the partial checkout on failure; mirror
     `addCheckout` in `infra/worktree/server/internal/worktree.ts:297-368`.
     No branch, no namespace probe, no worktree lock.
  4. Best-effort `mise trust <root>`, same as `worktree.ts:457-470`. The
     committed trust glob only covers `.claude/worktrees`.
- `disposeReleaseCheckout(name)`:
  - `git worktree remove --force` under the mutate slot.
  - If git no longer knows the dir, fall back to `rm -rf`, allowed only for a
    direct child of `releaseCheckoutsDir` (the counterpart of
    `isCanonicalWorktreePath` for this dir).
  - `git worktree prune`.
  - Remove the scratch namespace's data dir
    `worktreeArtifacts`/`worktreeDataDir(name)`. The inner build writes
    `release-web/<composition>` and check logs there.
  - Release the flock.
- `sweepLeakedReleaseCheckouts()`: for each child of the dir, try its lock; if
  the lock is free, dispose the checkout. Contain and log per-entry failures.
- `isReleaseCheckout(root)`: true when `root` is a direct child of
  `releaseCheckoutsDir`.
- Name = the run id (`basename(out)`, e.g. `release-1789637820602-toe2lm`).
  It is unique by construction, matches `NAMESPACE_LABEL_RE`, and never
  collides with a live worktree name.

### 2. `plugins/framework/plugins/cli/plugins/release/cli/run.ts`

After flag validation, `out` resolution and the provenance read (step 0), choose
one of three modes:

| Invoking checkout | Mode |
|---|---|
| `isReleaseCheckout(root)` | **inner** — build here (today's pipeline) |
| main, or a clean worktree | **pinned** — outer orchestrator |
| worktree with `commitDirty` | **in place** — today's pipeline, plus a line saying uncommitted changes are included and the tree is not isolated |

**Pinned (outer) mode:**
1. `acquireReleaseCheckout({ sourceRoot: root, sha: provenance.commitSha, name: basename(out) })`.
2. Print `Building <sha> from a private checkout: <path>`.
3. `spawnPassthrough(["bun", <checkout>/plugins/framework/plugins/cli/bin/index.ts, "release", ...same flags, "--out", out], { cwd: checkout })`.
   Always forward `out`, so the bundle lands in the invoking checkout's
   namespace. The inner process's orphan guard already ties it to the outer
   process.
4. `finally` → `dispose()`, also on SIGINT/SIGTERM via the CLI's existing
   fatal-signal exit path. Exit with the child's code.

**Inner-mode fixes.** Anything that derives identity from `root` must derive it
from `out` instead; `root`'s basename is now the scratch name:
- `pruneReleaseRunDirs(checkoutWorktreeName(root), …)` (~`run.ts:1139`) becomes
  the namespace/composition dir derived from `out` (`dirname(out)`).
- Audit every other `checkoutNamespace(root)` / `checkoutWorktreeName(root)` use
  in `run.ts` and `hermetic-build.ts`. The release-web dist dir may stay keyed by
  the scratch name, because producer and consumer agree and dispose removes it.
  `claimLatestPointer` must target `dirname(out)`.

### 3. Tauri

In inner mode, set `CARGO_TARGET_DIR = releaseCargoTargetDir.ensure()` for the
`tauri build` spawn. Otherwise every desktop release would compile Rust cold
inside a fresh `tauri/src-tauri/target`.

### 4. Docs

- `plugins/release/CLAUDE.md`: how a release gets its source tree (the three
  modes and why).
- The new plugin's `CLAUDE.md`.
- Regenerated plugin docs via build.

## Critical files

- `plugins/framework/plugins/cli/plugins/release/cli/run.ts` — mode split, outer orchestrator, `out`-derived identity
- `plugins/release/plugins/source-checkout/{server,data-dirs}/…` — new
- `plugins/release/CLAUDE.md`
- Reused as-is: `infra/worktree/server` (`withWorktreeMutateSlot`, `ensureMainWorktreeRoot`), `infra/spawn/core` (`spawnCaptured`, `spawnPassthrough`), `packages/flock/core` (`flockTry`/`flockRelease`), `infra/paths/core` (`defineDataDir`, `worktreeArtifacts`), `release/plugins/bundles/server` (`readGitProvenance`, `releaseOutDir`)
- Unchanged: `release/server/internal/release-job.ts`, `enqueue-release.ts`, `deploy/…/run-deploy.ts`

## Risks to check during implementation

- `bun install` in a fresh checkout runs postinstall provisioning (the
  `provision/` runners, e.g. chromium). Confirm it is cached and quick, or skip
  what a release doesn't need.
- Phantom namespace: `~/.singularity/worktrees/<run-id>/` exists during a
  release. Confirm the orphan audits (`paths:no-undeclared-data-dirs`, reclaim)
  don't flag or reap it mid-run.
- The check-stall "Details:" pointer in the transcript points into the scratch
  data dir, which dispose removes. That is acceptable, since the transcript has
  the output; note it in docs.
- The outer process still loads its own modules from main's live tree for a
  moment at startup. That window is milliseconds, not the ~8 min type-check
  window.

## Verification

1. **Unit tests** (`./equin test plugins/release/plugins/source-checkout`),
   using a temp git repo:
   - acquire creates a detached checkout at the sha;
   - dispose removes the checkout, its registration and its data dir;
   - dispose refuses paths outside `releaseCheckoutsDir`;
   - sweep removes an entry whose lock is free and keeps one whose lock is held.
2. **Pinned release, by hand**, from a clean committed worktree:
   `./equin release --composition website --target web --platform linux-x64`.
   Check:
   - the transcript shows the private checkout;
   - `RELEASE.json` has `commitSha == HEAD` and `commitDirty: false`;
   - afterwards the checkout, `git worktree list` entry and
     `~/.singularity/worktrees/<run-id>` are all gone;
   - wall time is comparable to the 493 s baseline.
3. **Race:** during a pinned release, move the invoking worktree's HEAD
   (`git checkout <other sha>`). The release still succeeds and records the
   original sha.
4. **Leak:** `kill -9` the outer process mid-build. The next release's sweep
   removes the leftover checkout.
5. **Dirty worktree:** make an uncommitted change, then release. It builds in
   place, prints the note, and marks the bundle dirty.
6. `./equin build`, then `./equin check`
   (including `paths:no-undeclared-data-dirs`).
7. **Deploy update:** re-run Deploy → website → update. This touches the remote
   server, so only after asking the user.
