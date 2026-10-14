# Checkout watch: drop git-ignored working-tree changes at the hub

## Context

`conversations/conversation-view/code/server/internal/watch-edited-files.ts` recomputes a
worktree's edited-files list (4 heavy-read git commands, behind the 2-slot
`withHeavyReadSlot` gate) on every checkout-watch batch except those made up only of
"build output", which it recognises with a hard-coded segment set
(`dist`, `build`, `.next`, `.turbo`, `.cache`, `coverage`). Anything else git ignores still
triggers a recompute. In the main checkout that means every change under `.claude/worktrees/**`,
which happens all the time. These changes can never change the list, because `git status`
ignores them. Since the 2026-10-12 coalescing change the cost is bounded (one running plus one
pending recompute per room), but it still uses up heavy-read capacity under host load.

Two more facts found while reading the code:

- **The heuristic has a bug.** It matches *any* path segment, so a real source edit under
  `plugins/framework/plugins/cli/plugins/build/…` (or any folder named `build` / `coverage`)
  is skipped as "build output", and the edited-files list goes stale. `build/`, `.next/`,
  `.turbo/` and `coverage/` aren't even in the repo's `.gitignore`.
- **The other checkout-watch reader handles the same problem its own way.**
  `apps/file-explorer/git/server/internal/live.ts` keeps a per-root `lastIndex` from its
  last `git status --ignored` and drops changes `isIgnored(rel)` finds (`matters()`).

So there are two readers of one primitive, each with its own approximation of "git ignores this
path". Both readers' state is derived from git, and by definition a git-ignored, untracked path
cannot move it.

## Approach

Move ignore-filtering into the checkout-watch hub (`infra/git/checkout-watch`). It drops
working-tree changes git ignores **before delivering to any reader**, using git's own answer:
one `git check-ignore -z --stdin` per batch, per checkout (shared by all readers), not per
reader. This removes the mistake at its source: no reader can recompute on an ignored path,
because it never hears one.

### Why `git check-ignore`

Checked against the main checkout:

- It is exact: it covers nested `.gitignore`s, `.git/info/exclude` and `core.excludesFile`,
  with no pattern parser of our own to drift.
- Paths **inside** an ignored dir are reported ignored, including paths that no longer exist
  (`.claude/worktrees/<wt>/nonexistent/x.ts` → ignored). Deletions are therefore handled.
- `plugins/framework/plugins/cli/plugins/build/cli/index.ts` → not ignored (fixes the bug above).
- Without `--no-index`, **tracked** files are never reported as ignored, so a change to a
  tracked file that matches an ignore pattern still gets through. That is correct, because
  `git status` shows it.
- A `.gitignore` edit is itself not ignored, so it gets through, and later checks use the new
  rules.
- Cost: pattern matching plus an index read, no tree walk or object reads. It is not a
  heavy read and doesn't take a heavy-read slot. At most one spawn per debounced batch
  (200 ms debounce / 2 s ceiling), versus the 4 heavy-read commands it saves.

### Changes

1. **`plugins/infra/plugins/git/plugins/checkout-watch/server/internal/hub.ts`**
   - New dep on `CheckoutWatchDeps`:
     `ignored: (root: string, relPaths: readonly string[]) => Promise<ReadonlySet<string>>`
     (the subset git ignores). Inject it like `locate` / `readBranch`, so the hub tests stay pure.
   - In the existing `deliver` coalescer's `run`: if the batch has `worktree` changes, take
     their unique relative paths and call `deps.ignored` once. Drop the ignored ones, then go on
     to the existing HEAD-reread / emit logic. A batch that ends up empty emits nothing.
     A batch with no worktree changes stays synchronous, as now. The coalescer already
     serialises runs and folds batches that arrive mid-run, so the extra await adds no queueing.
   - Failure (fail loudly, same pattern as `rereadThenEmit`): if the check throws, emit the
     batch **unfiltered** (readers over-recompute; nothing is lost), then rethrow. The coalescer
     records the failure as a failed run. `WorktreeGoneError` → emit unfiltered and don't
     rethrow; readers already handle a reaped checkout.
   - Keep the `node_modules` drop in `classifyRootEvent`. It is a cheap pre-filter that keeps
     install-sized batches (tens of thousands of paths) off check-ignore's stdin.

2. **`.../checkout-watch/server/internal/checkout-watch.ts`**: the real `ignored` dep.
   `git check-ignore -z --stdin` with the paths NUL-joined on stdin. Exit 0 → parse the
   NUL-separated output into a Set. Exit 1 → empty Set (git's legitimate "none ignored"
   answer, so use `tryRunGit`). Anything else → throw `GitError`.
   - `tryRunGit` / `spawnCaptured` need **stdin**: `spawnCaptured` already accepts `stdin`
     (`infra/spawn/core`). Add an optional `{ stdin }` option to `tryRunGit` / `runGit` in
     `primitives/commit-list/server/internal/run-git.ts` rather than spawning git by hand
     (keeps the timeout, the `--no-optional-locks` flag and the `WorktreeGoneError` handling).

3. **`watch-edited-files.ts`**: delete `BUILD_OUTPUT` / `isBuildOutput` and the early return.
   Every batch the hub delivers is now one that can move the list. Update the header comment.

4. **`apps/file-explorer/git/server/internal/live.ts`**: delete `matters()` and `lastIndex`.
   The hub drops the same changes, and does it exactly. Keep `indexGitStatus` / `isIgnored` if
   anything else uses them (the status-index tests suggest the UI uses them; only the
   `live.ts` use goes).
   Note: as today, a *new* ignored file appearing doesn't refresh file-explorer's greyed-out
   ignored entries. `matters()` already accepted that; behaviour stays the same.

5. **Docs**: in `checkout-watch/CLAUDE.md`, change "Dropped as noise for every reader" to add:
   working-tree paths git ignores (untracked, per `git check-ignore`). Remove "A reader drops
   more itself (edited-files skips build output)". Add a line in the hub's `acquireCheckoutWatch`
   JSDoc.

### Not doing

- No in-process `.gitignore` parser (such as the `ignore` package). It would have to track
  nested files, `info/exclude` and the global excludes file, which is a second ignore
  implementation that can drift from git.
- No opt-in flag per reader. Every reader of a *checkout* watch reads git state, and ignored
  untracked paths can't move it. A future reader that wants raw tree churn should use
  `acquireDirWatch`.

## Verification

- **Unit (`hub.test.ts`)**, with a fake `ignored` dep:
  - only-ignored batch → no delivery
  - mixed batch → only the kept changes are delivered
  - git-only batch → `ignored` not called
  - `ignored` throws → unfiltered delivery, then the failure surfaces
  - one `ignored` call per batch however many readers there are
- **Integration test** for the real dep, against a temp repo (`db-test-fixture`-style
  throwaway dir, `git init`). Cases:
  - untracked file in an ignored dir → ignored
  - non-existent path under an ignored dir → ignored
  - tracked file matching an ignore pattern → kept
  - `.gitignore` itself → kept
  - a dir named `build` that isn't ignored → kept
  - no ignored paths → empty Set (the exit-1 path)
- `./singularity test plugins/infra/plugins/git/plugins/checkout-watch plugins/conversations/plugins/conversation-view/plugins/code plugins/apps/plugins/file-explorer/plugins/git`
- `./singularity build` (checks, including the `watcher-safety` lint and the doc sync).
- **Live check:** on the deployed worktree, open a conversation whose code tab watches this
  worktree. Then:
  - `touch` files under an ignored path (`dist/x`, and from main `.claude/worktrees/...`) →
    Debug → Background activity / runtime profiler shows no new
    `watch-edited-files:recompute` runs.
  - Edit a file under `plugins/framework/plugins/cli/plugins/build/` → the edited-files list
    updates (the bug fix).
