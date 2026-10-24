# A folded doc line recorded process history, so the generated doc was never a function of the checkout

> **Read the CORRECTION section first.** The opening sections chase a merge-driver theory that
> turned out to be a real but SEPARATE bug. The push failures were caused by the fold listing
> ids in runtime declaration order.

## Context

The branch `claude-web/att-1787004352-y9l7` carries one commit: web config registrations
gain a `docLabel`, and the contributions facet folds a long same-slot run onto one line
(plan: `research/2026-08-18-global-contribution-doc-labels-and-folding.md`). The source
change is small, verified, and deployed.

It has now failed to land **five times**, always on the same check:

```
• plugins-doc-in-sync ... FAIL
  docs/plugins-details.md is out of sync with plugin source
```

This doc records what the failure actually is, because the obvious readings are all wrong
and each one costs ~13 minutes to disprove.

## What is certain (measured, not inferred)

1. **The committed doc is canonical on a settled tree.** On the current rebased tree,
   `bun plugins/framework/plugins/cli/bin/index.ts regen-generated` produces **zero** diff.
   `plugins-doc-in-sync --no-cache` passes standalone. Ran both, repeatedly, on three
   different rebase bases.
2. **It is not a race with main.** One failure occurred with `origin/main` stationary at
   `97bede4e1` before and after the push.
3. **It is not stale rebase state.** One failure occurred from a clean rebase with no
   leftover `rebase-merge` dir and no unconsumed marker.
4. **The rebase really does revert the doc.** After a manual `git rebase origin/main`,
   `docs/plugins-details.md` held **331 bare `ConfigV2.WebRegister` lines** (main's content)
   while `plugins/config_v2/web/internal/slots.ts` still held my `docLabel`. Source and
   generated artifact disagreed, in the commit.
5. **The repair works when it runs.** `./equin normalize-generated` on that state
   consumed the marker, regenerated (0 bare lines, 6 folded), and amended the commit.

## The mechanism

`.gitattributes` routes generated artifacts through custom merge drivers:

```
docs/plugins-details.md    merge=regen-generated
plugins/**/CLAUDE.md       merge=regen-claudemd
```

`scripts/regen-generated.sh` resolves a conflict by **taking main's side verbatim** and
`touch`ing `$GITDIR/singularity-merge-markers/generated`. That is a deliberate half-fix:
the file is a pure function of sources git just merged correctly, so the canonical content
is re-derived afterwards by `normalizeGeneratedArtifacts` — driven by `.githooks/post-rewrite`
for a manual rebase, or by `push` itself at step 3c for its own rebase.

For an ordinary branch this is invisible: main's doc and mine agree, so re-deriving is a
no-op. **This branch changes the generator**, so main's doc is wrong for my sources by
~1,470 lines. Every rebase therefore installs a doc that contradicts my code, and the
entire correctness of the push rests on the repair firing before the checks.

Push's ordering is right on paper (`bin/commands/push.ts`):

```
3.  git rebase main --exec 'git commit --amend … --trailer Singularity-Push=<id>'
3b. installRebasedDeps()
3c. normalizeGeneratedArtifacts(root, { pushId })   // regen + clear markers + amend
4.  runRebasedChecks(root)                          // FAILS HERE
```

So the check sees an un-repaired doc even though 3c ran. The tree then **self-heals after
the push** (the abort path / post-rewrite hook), which is why every post-mortem inspection
shows a clean tree and why fact (1) above kept misleading me.

## CORRECTION — the cause above is NOT what failed the pushes

The sections above were written mid-investigation and their conclusion is WRONG. Keep them
for the merge-driver bug they document (which is real, see "Second bug" below), but the
push failures had a different cause, proved by one fact the merge-driver story cannot
explain: **`plugins-doc-in-sync` also failed inside a plain `./equin build`, with no
rebase anywhere in it.**

### The actual cause: the fold made the doc depend on process history

`renderValues()` folded a long same-slot run onto one line listing the ids **in array
order**. For the biggest group that order is the runtime slot-DECLARATION order — `reorder`
mints one `ConfigV2.WebRegister` per reorderable slot from a `subscribeSlotsDeclared`
callback, in whatever order barrels happened to be imported in that process. Its server twin
looks sorted only because it maps over the pre-sorted `reorderableSlots.generated.ts`.

Measured: the committed line read `×213: "text-editor.plugin", "conversation.action-bar",
"conversation.header", "apps.app", …` — plainly not sorted.

Before folding, those 213 lines were byte-identical, so the varying order was invisible.
Folding turned an order-INsensitive rendering into an order-sensitive one, and
`docs/plugins-details.md` stopped being a pure function of the checkout. That is exactly why
the check passed every time it was run ALONE and failed inside every full run — running it
alone was the one case that could not fail, and it was the case I kept measuring.

**Fix (landed):** sort the labels in the folded line. The folded line collapses entries whose
only distinguishing content is the label, so it denotes a SET, and a set must be spelled in a
canonical order. The per-line (unfolded) path keeps its original order. After the fix a full
`./equin build` passes checks.

## Second bug, real but not the blocker: the marker lands where nobody reads it

- **The marker is written where normalize doesn't read it.** The driver takes
  `GITDIR=$(git rev-parse --git-dir)`; `readMergeMarkers()` takes `resolveGitDir(root)`.
  Inside a rebase, drivers and hooks inherit `GIT_DIR` pointing at the rewrite in progress —
  `post-rewrite` explicitly `unset`s it for exactly this reason, the merge driver does not.
  If they disagree, `normalizeGeneratedArtifacts` reads **zero** markers and returns early
  (`if (markers.length === 0) return`) — a silent no-op that looks identical to "clean merge".
- **The `--exec` amend interleaves.** Push amends every replayed commit mid-rebase;
  `post-rewrite` deliberately skips those, leaving the marker for the end-of-rebase pass.
  Whether that marker survives push's own `rebaseEnv()` suppression is untested.

**Confirmed empirically**, with `GIT_DIR` set the way a rebase driven from the main worktree
sets it:

```
resolveGitDir(root)              -> /…/.git/worktrees/att-1787004352-y9l7
old driver, poisoned GIT_DIR     -> /…/.git                (WRONG — nobody reads here)
new driver (GIT_* unset first)   -> /…/.git/worktrees/att-1787004352-y9l7
```

So the marker could be written somewhere `readMergeMarkers()` never looks, and
`normalizeGeneratedArtifacts` would return early — a silent no-op indistinguishable from
"the merge was clean". Real, worth fixing, and fixed here; just not what was failing my
pushes.

## Fix

**Rung 4 — make the silent no-op impossible (the real fix).** `normalizeGeneratedArtifacts`
returns early on zero markers, which is indistinguishable from "the merge was clean". After
a rebase that *did* auto-resolve, that early return is a lie. Replace the marker-presence
heuristic with the ground truth it is a proxy for: regenerate unconditionally and assert the
tree is canonical. Regeneration is idempotent and already the same pipeline `build` runs, so
the only cost is time on a path that is already minutes long. A push must never reach its
checks with an artifact that disagrees with its own sources.

If the marker mechanism is kept, it must at least be made honest: resolve the marker dir
from the worktree root in the driver too (`git rev-parse --git-common-dir` / explicit
worktree gitdir, not the inherited `GIT_DIR`), and have `push` **fail loudly** when a
post-rebase regeneration produces a diff after normalize claimed success.

**Rung 3 — the backstop that should have caught this.** `generated-artifacts-normalized`
exists to fail on a surviving marker, and never fired: the marker was cleared while the
artifact was still wrong. Clearing must be conditional on the artifact actually being
canonical, not on the regen command exiting 0.

**The fix that actually unblocked the branch** was sorting the folded line — see the
CORRECTION section. Fact (1) above ("regeneration is a verified no-op on a settled tree") is
true but was measured only in a single-process regen, which is precisely the case that cannot
expose an order dependence. It is what made the fold look innocent for three days.

## Landing this branch meanwhile

The branch only fails when main's new commits touch `docs/plugins-details.md`. To land it
without fixing push first:

1. `git fetch origin main && git rebase origin/main` (background — a foreground rebase hit
   the 2-minute cap once and left a `rebase-merge` dir that broke the next push).
2. `./equin normalize-generated` — verify `grep -c '`ConfigV2.WebRegister`$'` is **0**
   and `grep -c '×[0-9]*:'` is **6**.
3. `./equin push` immediately.

Step 3 still races: if main lands a doc-touching commit inside the push window, the driver
reverts again and the push fails the same way. That race is the bug, not the workaround.

## Verification

- Reproduce deliberately: rebase onto a main that changed `docs/plugins-details.md`, then
  *before* normalizing, confirm the working tree holds main's doc while the source holds the
  new generator. That is the state push checks in.
- After the fix: the same rebase, followed by `push`, must reach step 4 with
  `regen-generated` producing an empty diff.
- Regression guard: a commit that edits a doc generator (this one) must push on the first
  attempt with main actively advancing.
