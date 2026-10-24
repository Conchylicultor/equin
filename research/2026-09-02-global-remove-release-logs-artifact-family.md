# Remove the release-logs artifact family

**Date:** 2026-09-02
**Category:** global (`plugins/infra/plugins/paths` + `plugins/release`)

## Context

Commit `315dd4cd4` ("feat(supervised-run): long-running work survives a backend
restart", 2026-09-01) moved release runs onto the supervised-run primitive. The
child now writes its own transcript to `runs/release-<runId>.log` through a
kernel fd, for every run whatever becomes of it. That deleted the parent-side
writer of `release-logs-<id>.json` — and with it the only caller of the prune
that bounded those files.

What the migration did **not** remove is the machinery around the artifact. A
reader opening `prune-artifacts.ts` today sees a `RELEASE_FAMILY` sitting beside
a live `BUILD_FAMILY` and `CHECK_FAMILY`, a `RELEASE_ARTIFACTS_RETENTION = 50`
with a paragraph of rationale, and two exported prune functions — all of which
look exactly as live as their working siblings. Nothing signals that this one
column of the table is dead.

The intended outcome is that the family stops existing: no writer, no pruner, no
retention constant, no path helper, no check pattern, no reader.

### What the research established

Three facts change the shape of the job from how it was originally framed.

**1. The work splits into two halves that are not entangled with each other.**

- **Provably dead, zero callers.** `pruneWorktreeReleaseArtifacts` is called
  *nowhere* — it is defined, re-exported from the server barrel, and named once
  in a disambiguating prose comment. Its three siblings all have real callers
  (`pruneWorktreeBuildArtifacts` ← `profiler.ts` / `build-logs-writer.ts`;
  `pruneWorktreeCheckArtifacts` ← `checks/core/transcript.ts`;
  `pruneWorktreeRunArtifacts` ← `supervisor.ts:507`), which is what makes this
  one the outlier rather than a judgment call. `pruneReleaseArtifactsInDir` is
  reached only by its own tests. Removing this half touches neither the check
  nor the fallback.
- **Gated on the legacy fallback.** `worktreeArtifacts.releaseLogs` has exactly
  one caller: `transcript.ts:85`, inside `readLegacyReleaseLogs`. The check
  pattern and the test fixture exist to police that filename. All three live or
  die with the fallback.

  The gate is real and one-directional: the fallback names its file *through*
  the record helper, so deleting `worktreeArtifacts.releaseLogs` while keeping
  the fallback would force `transcript.ts` to inline `release-logs-${id}.json`
  — which the check would then flag, since `plugins/release/` is not on its
  allowlist. The two cannot be separated.

**2. The check does not derive its patterns from the record.**
`WORKTREE_ARTIFACT_PATTERNS` (`check/index.ts:146-194`) is a hand-written array
of ten regexes that mirrors `worktreeArtifacts` by convention only. Removing the
`releaseLogs` entry therefore changes nothing about the check automatically —
pattern #4 must be deleted by hand, or it keeps flagging a filename with no
canonical helper left to point offenders at. (See *Follow-up* below.)

**3. The residue is far smaller than the ~50/worktree bound suggests.** On this
machine there are **two** files, **62 KB**, in the main worktree only:

| file | size | run | outcome |
|---|---|---|---|
| `release-logs-release-1785942984636-dmsdcv.json` | 49 KB | 2026-08-05 | failed |
| `release-logs-release-1787883949060-obxecd.json` | 12 KB | 2026-08-28 02:25 | failed |

`release_runs` holds three rows in total. The newest — `release-1787890677598-a5g505`,
2026-08-28 04:17, **succeeded** — postdates the second failure by under two
hours and has no legacy file. So both surviving files belong to failures that
were diagnosed and fixed, and the fallback's own stated condition ("once no run
old enough to have one is still worth reading") is met.

## Recommendation

Do the whole removal in one pass, including the fallback. Keeping it preserves
the log pane of two resolved failures at the cost of holding three other pieces
of machinery alive across the codebase — and guarantees this task gets done
twice.

The two stages below are written so they remain independently valid: if the
fallback should stay after all, drop Stage 2 and Stage 1 still stands on its own
with no loose ends.

**The two files stay on disk.** Nothing will read them once Stage 2 lands, but
62 KB of inert bytes costs nothing and leaving them keeps the decision
reversible. Do *not* add a legacy sweep to reap them — re-adding machinery to
delete a family we are removing is the wrong trade for one-time cleanup, and the
`LEGACY_CHECK_LOG` precedent in `pruneCheckArtifactsInDir` only pays off because
a *live* prune was already scanning that directory. They can be removed by hand
whenever, with:

```bash
rm ~/.singularity/worktrees/singularity/release-logs-*.json
```

## Stage 1 — the write-side machinery (no decision required)

`plugins/infra/plugins/paths/core/internal/prune-artifacts.ts`
- Delete `RELEASE_ARTIFACTS_RETENTION` (the const at :49 and its 15-line
  docblock at :34-48).
- Delete `RELEASE_FAMILY` (:99-104).
- Delete `pruneReleaseArtifactsInDir` (:259-262) and
  `pruneWorktreeReleaseArtifacts` (:316-322).
- In `pruneArtifactsInDir`'s docblock (:199-207), drop "run-release's failure
  fallback" from the list of callers that prune-on-write.

`plugins/infra/plugins/paths/server/index.ts`
- Drop `pruneWorktreeReleaseArtifacts` (:62) and `RELEASE_ARTIFACTS_RETENTION`
  (:66) from the re-export block.

`plugins/infra/plugins/paths/core/index.ts`
- The comment at :56-63 explains that "the build/release prunes stay
  server-only exports because every one of their writers is server-side". After
  this stage release has no writer at all — reword to name build only.

`plugins/infra/plugins/paths/core/internal/prune-artifacts.test.ts`
- Delete the `pruneReleaseArtifactsInDir` import (:14) and its whole
  `describe` block (:234-295).
- Delete the build-describe test `never touches release-family files`
  (:226-242 region) outright — it asserts disjointness against a family that
  will not exist. Its sibling `never touches check-family files` already
  carries that intent against a surviving family, and does it better (the two
  `.log` families are the pair that actually share a suffix).
- In `leaves unrelated per-worktree files untouched`, drop the
  `release-logs-r1.json` seed and its assertion; `spec.json` and `check.log`
  still carry "unrelated".
- Rename `never touches build- or release-family files` → `never touches
  build-family files` and drop its `release-logs-r1.json` seed + assertion.

## Stage 2 — the reader and its guards

`plugins/release/server/internal/transcript.ts`
- Delete `readLegacyReleaseLogs` and the `LegacyReleaseLogsFile` interface.
- Collapse the fallback branch: `if (text === null) return readLegacyReleaseLogs(releaseId);`
  becomes `if (text === null) return [];`.
- Rewrite the `{@link readLegacyReleaseLogs}` sentence in
  `readReleaseTranscript`'s docblock (:38-41). The surviving statement is the
  one already there and still true: a run whose transcript the supervised-run
  prune has reaped genuinely has nothing to show, so an empty list is an answer
  rather than a swallowed failure.
- Keep the `worktreeArtifacts` import — `runTranscript` still uses it.

`plugins/infra/plugins/paths/core/internal/paths.ts`
- Delete the `releaseLogs` entry (:392-394).
- Fix `checkLog`'s docblock (:374-375), which anchors its "ALWAYS id-keyed"
  argument to `releaseLogs`: *"ALWAYS id-keyed (like `releaseLogs`, unlike
  `buildStatus` directly above)"*. Re-anchor to a surviving id-keyed sibling —
  `runTranscript` is the natural one — so the contrast with `buildStatus`
  survives intact.

`plugins/infra/plugins/paths/check/index.ts`
- Delete the release-logs pattern entry (:158-159).
- Drop `release-logs-*.json` from the `hint` string (:243).
- Reword the header comment (:136-137) — "the build/release artifact filenames"
  → the build artifact filenames.

`plugins/infra/plugins/paths/check/no-inlined-worktree-artifacts.test.ts` —
**swap the fixture, do not just delete it.** `L3` is the only *template
literal* among the five flagged lines; the other four are plain strings.
Deleting it would quietly drop the coverage that proves `maskStrings: false`
keeps template literals in scope, which is the whole reason that fixture is
spelled the way it is.

`build-logs` is the drop-in: same `<family>-<id>.json` shape, already pattern
#3 in both the check and this test's mirror, and currently used only as the
*negative* lookalike at `L9` (`@plugins/build/plugins/build-logs/core`, unflagged
for want of a `.json` suffix). After the swap that pair reads better than what
it replaces — one family, positive and negative, three lines apart.

- Drop the mirrored release-logs pattern (:50); `PATTERNS` goes 6 → 5.
- `const RL = "release-" + "logs";` (:59) → `const BL = "build-" + "logs";`
- `L3` (:68) → `"const c = join(dir, " + BT + BL + "-$" + "{id}.json" + BT + ");"`
- Fixture comment (:77) → `L3 — FLAGGED (build-logs template)`.
- Counts: "The 6 {pattern, grepArg} pairs" (:15) → 5; "run all 6 patterns"
  (:104) → 5. The flagged-line count stays **5** and
  `expect(flaggedLines).toEqual([1, 2, 3, 4, 5])` is unchanged.
- Drop `release-logs-*.json` from the file docblock's filename list (:5).

### Stale comments to fix in the same pass

Both are wrong *today*, independently of this removal:

- `plugins/framework/plugins/cli/plugins/build/cli/internal/hermetic-build.ts:62`
  — claims a release "has its own durable artifact (`release-logs-<id>.json`)".
  Superseded by the transcript; say so.
- `plugins/conversations/.../op-status/server/internal/watcher.ts:15` — lists
  `release-logs-*.json` among the filenames the directory filter sees. No code
  change (the filter keys on the parent-dir basename), comment only.
- `plugins/release/plugins/bundles/server/internal/prune.ts:30` and
  `plugins/release/plugins/bundles/CLAUDE.md:88` disambiguate `pruneReleaseRunDirs`
  from `pruneWorktreeReleaseArtifacts`. Once the latter is gone the contrast
  names nothing — reword to state what `pruneReleaseRunDirs` bounds (run
  directories under `~/.singularity/state/releases/`) without the comparison.

### Explicitly out of scope — same words, different thing

`releaseLogsEndpoint`, `handleReleaseLogs`, and the Studio `release-logs` web
plugin are the **live** UI surface, now served from the transcript. `pruneReleaseRunDirs`
bounds release *bundle directories*, an unrelated live mechanism. None of these
change.

## Verification

1. `./equin check paths:no-inlined-worktree-artifacts` — passes with the
   pattern removed. Then confirm it still bites: temporarily add
   `const x = join(dir, ` + "`build-logs-${id}.json`" + `);` to a file outside
   `plugins/infra/plugins/paths/` and re-run; it must fail, naming that line.
   Revert.
2. `./equin test plugins/infra/plugins/paths` — the reworked check test
   and the trimmed prune tests pass.
3. `./equin check` — full sweep, for `plugins-doc-in-sync` (the autogen
   blocks in `paths/CLAUDE.md` and `docs/plugins-details.md` list the two
   removed server exports and must regenerate) and `type-check`.
4. `./equin build` — run in background, per the workflow rule.
5. Open Studio → Compositions → a release run's detail pane, on the **succeeded**
   run `release-1787890677598-a5g505`: its Logs section must still render from
   the supervised-run transcript. This is the regression that matters — the
   fallback removal must not disturb the live path.
6. Open one of the two pre-migration runs (`release-1785942984636-dmsdcv`).
   Expected *after Stage 2*: an empty log pane, not an error. Confirm the pane
   renders its empty state cleanly.
7. `rg -n 'release-logs|releaseLogs|RELEASE_FAMILY|RELEASE_ARTIFACTS_RETENTION'`
   — every surviving hit should be the live Studio plugin, `releaseLogsEndpoint`,
   a `research/` doc, or `bun.lock` / generated registries.

## Follow-up (not this change)

`WORKTREE_ARTIFACT_PATTERNS` is a hand-maintained mirror of `worktreeArtifacts`
with nothing binding the two. This task is precisely what that costs: the record
entry and the regex that guards it had to be found and removed by separate acts
of diligence, and either one could have been left behind silently. A rung-3
guard ("every id-keyed `worktreeArtifacts` filename has a pattern, and every
pattern has a filename") would close it. Worth filing, but it is a design
problem of its own and does not belong inside a deletion.
