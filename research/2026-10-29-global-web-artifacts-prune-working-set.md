# Web-artifacts prune deletes in-flight builds' artifacts; git-scan timeout fails a check

## Context

Worktree `att-1793291041-5u20ov` failed `./equin build` twice at compose:
"7 mapped URL(s) do not resolve to a real file". The missing URLs are exactly
the 4 artifacts that run built ("4 built, 1663 reused"); none of their store dirs
exist.

**Root cause** (`web-artifacts/core/internal/store.ts` `pruneCacheDir`): the
count cap counts referenced entries (link targets of served dists) toward the
total but never removes them. Measured now: the store holds 9074 entries, and
**all 9074 are referenced** by some served dist (28k links across worktrees),
far above `TRIM_TO` = 6000. So `excess = min(candidates, total − 6000)` =
*every* unreferenced entry, on every build's prune. A freshly published artifact
is unreferenced until its own build composes and swaps its dist in, so any
concurrent build (another worktree, there are always some) deletes it in that
window. The failing builds' web-artifacts stage took 200–360 s under load, a
wide window. The same function prunes vendor sets and the global-CSS cache, which
have the same exposure.

A smaller gap of the same kind: a reused entry is checked with `hasArtifact` at
plan time but only `touchArtifact`-ed later in the build stage, so an old,
unreferenced reused entry can be aged/trimmed out between the two.

Second, unrelated failure in the same run: `investigate:failures-registered`
threw `GitScanError: git cat-file --batch timed out after 120s`
(`checks/core/grep-code.ts`). A timeout is environmental (host load), but every
throw is turned into a fatal FAIL by `thrownOutcome` — there is no way for
shared check plumbing to say "inconclusive".

## Fix 1 — the prune never trims the working set

> **Superseded, not landed.** While this was in review, main landed 8fa9b8d00e
> ("build pins + 1-minute prune margin against concurrent builds"): every build
> pins each entry it builds or reuses into a `web.*` sibling of its dist, which
> `servedDistTargets` already reads as roots — the exact lease design rejected
> below, done without a lock thanks to the snapshot margin. Only Fix 2 landed.


`pruneCacheDir` (store.ts): an entry modified within the last hour
(`WORKING_SET_MS`, the same grace `.tmp.*` dirs already get) is never a
count-cap victim. Builds bump mtime on everything they publish or reuse, so
the working set of every in-flight build is exactly "recently touched".
The cap stays a soft bound, as it already is for referenced entries. The 14-day
age-out is unaffected (it already spares anything recent).

Close the plan-time gap: add `claimArtifact(dirName): boolean` in store.ts
(present → touch, return true) and use it where the build *plans* reuse
(`plan.ts` ×3, `browser-hosts.ts`), so the entry is fresh from the moment the
build decides to reuse it. Read-only callers (`check/`, `expected.ts`) keep
`hasArtifact`. The later `touchArtifact` in `pipeline.ts` / `browser-hosts.ts`
becomes redundant and is dropped.

Rejected: per-build lease files under flock. Exact, but it needs a lock between
prune and lease writers to be race-free, and three cache kinds to register into
it. The mtime working set covers all three with one rule.

## Fix 2 — environmental throws are inconclusive

- `framework/tooling/core`: export `InconclusiveCheckError extends Error`
  (with an optional `hint`). It is the typed way shared check plumbing says
  "could not decide, environmental".
- `checks/core/thrown-outcome.ts`: an `InconclusiveCheckError` maps to
  `{ ok: false, inconclusive: true, message, hint }` (non-fatal, never cached).
  Any other throw stays a fatal FAIL.
- `grep-code.ts`: a timed-out spawn throws `GitScanTimeoutError extends
  InconclusiveCheckError`. Other git failures (bad pattern, truncated stream)
  stay a fatal `GitScanError`.

## Verification

- Unit tests: `served-dists.test.ts` / a store test gets a case where
  referenced > trimTo and a fresh unreferenced entry survives while an old one
  is trimmed; `thrown-outcome.test.ts` gets the inconclusive mapping.
- `./equin test plugins/framework/plugins/tooling/plugins/web-artifacts plugins/framework/plugins/tooling/plugins/checks`
- `./equin build` in this worktree.
