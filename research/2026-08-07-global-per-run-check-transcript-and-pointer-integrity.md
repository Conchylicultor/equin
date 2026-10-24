# Per-run check transcript, and a build pointer that always names a written file

**Date:** 2026-08-07
**Category:** global (`cli` + `framework/tooling/checks` + `build` + `infra/paths`)

## Context

Two defects in how a build's log artifacts are *addressed*. Both surfaced while
investigating main's build `build-1786028341655-x0pix4`, SIGTERMed mid-checks on
2026-08-06.

**1. The check transcript is one fixed path per worktree.**
`~/.singularity/worktrees/<wt>/check.log`, written with a truncating
`writeFileSync` only AFTER every check settles
([`checks/core/runner.ts:411`](../plugins/framework/plugins/tooling/plugins/checks/core/runner.ts)).
Every sibling build artifact is per-run (`build-<id>.log`,
`build-logs-<id>.json`, `build-profile-<id>.json`); this one is not. So:

- a run killed during checks writes nothing and silently leaves its
  predecessor's transcript in place;
- two runs in one worktree clobber each other;
- a verdict that names the path (`Check logs: …/check.log`) can point at another
  run's output. Observed directly: main's `check.log` held the superseded build
  `tue6g2`'s failing transcript while the reported failure was `x0pix4`.

**2. A verdict pointer to a file that was never written.**
When a build is killed, the CLI's exit-time guard prints
`Full output: …/build-<id>.log`
([`bin/build-output.ts:121`](../plugins/framework/plugins/cli/bin/build-output.ts))
— and nothing ever writes that file: `writeBuildLogs` is only called from the two
verdict paths ([`commands/build.ts:1250,1429,1511`](../plugins/framework/plugins/cli/bin/commands/build.ts)),
neither of which a killed build reaches. The backend's recovery
([`build/server/internal/run-build.ts:345-372`](../plugins/build/server/internal/run-build.ts))
replays that captured text into the run detail pane at `/debug/build/r/<id>`, so
the UI shows a pointer to a file that does not and cannot exist — but the UI is
only where it is *visible*. The dangling pointer is minted by the CLI, and a
`./equin build` killed in a plain terminal (no backend capturing it) prints
the same lie with no fallback at all.

### The existing decision this must stay coherent with

The deploy receipt (`build-status.json`) is *deliberately* one fixed path with no
`<id>` variant ([`paths.ts:168-179`](../plugins/infra/plugins/paths/core/internal/paths.ts),
[`cli/CLAUDE.md`](../plugins/framework/plugins/cli/CLAUDE.md)), precisely so "did
my build land?" cannot be answered by a previous run's artifact.

That works because the receipt is **written early** — at lock grant, as
`status: "running"` — so a killed build leaves a self-describing *incomplete*
file of its own, never a stale complete one. The check transcript has the
fixed-path property without that property, and gets exactly the failure mode the
receipt was designed to avoid.

So the rule the two share, stated once: **an artifact must never be able to
impersonate a run that did not write it.** The receipt buys that with an early
write; a transcript that can only be complete at the end buys it with identity.
Both fixes below follow from that one rule, and neither contradicts the receipt.

## Part 1 — the check transcript becomes a per-run artifact

`check-<id>.log`, where `<id>` is the id the caller **already owns**: the
`buildId` for a build's checks, the check command's `opId` for a standalone run.
Not a fresh id — reusing the caller's is what makes the transcript joinable to
`build-<id>.log` / `build-logs-<id>.json` beside it, and to the run's lines in
`check-progress.jsonl`.

### 1a. The path joins the canonical registry

`plugins/infra/plugins/paths/core/internal/paths.ts` — add to `worktreeArtifacts`:

```ts
/**
 * A single check run's full, untruncated transcript. ALWAYS id-keyed (like
 * `releaseLogs`, unlike `buildStatus`): it can only be complete once the run
 * ends, so a fixed path would let a killed run's verdict point at its
 * predecessor's file. The receipt gets the same guarantee from an EARLY write
 * instead — see `buildStatus` above; do not converge the two.
 */
checkLog: (name: string, runId: string): string =>
  join(worktreeDataDir(name), `check-${runId}.log`),
```

`plugins/infra/plugins/paths/server/internal/prune-artifacts.ts` — a third family
beside `BUILD_FAMILY` / `RELEASE_FAMILY`:

```ts
const CHECK_FAMILY: ArtifactFamily = {
  patterns: [{ prefix: "check-", suffix: ".log" }],
  tmpPrefixes: ["check-"],
};
```

plus `CHECK_ARTIFACTS_RETENTION = 50` and
`pruneWorktreeCheckArtifacts(name, keep?)`. The families stay disjoint —
`check-<id>.log` does not start with `build-`, so `BUILD_FAMILY` cannot swallow
it. Called once per run, at the transcript's terminal write (same
"writing a new set trims the old ones" convention as `writeLogs`); a killed run
skips its prune and the next completed run reaps it.

Same file: sweep a bare legacy `check.log` when the check family is pruned, with
a comment marking the line removable once the fleet has turned over — leaving the
old fixed-path file behind invites exactly the misreading this change removes.

### 1b. The runner owns the path, so the id cannot drift

`checks/core/runner.ts` — replace `RunChecksOptions.logFile?: string` with:

```ts
/** The run this transcript belongs to. The runner derives the path itself
 *  (worktreeArtifacts.checkLog) AND uses `runId` as the progress-log run id, so
 *  the filename and the `check-progress.jsonl` lines can never name different
 *  runs. */
logRun?: { worktree: string; runId: string };
```

`openProgressRun` ([`checks/core/progress-log.ts:145`](../plugins/framework/plugins/tooling/plugins/checks/core/progress-log.ts))
takes an optional `runId`, defaulting to today's `crypto.randomUUID()`. Its own
`worktreeName()` derivation stays untouched — its docblock explains why
`REPO_ROOT` is the only correct source there; `logRun.worktree` is a separate
fact (which data dir the artifact sits in, beside that worktree's build
artifacts) and comes from the caller, exactly as `build-<id>.log`'s does.

### 1c. The file exists from the moment checks begin

Today `full[]` is populated only in the print loop, which runs after
`Promise.all` — a run killed mid-checks reaches it never. Move the transcript off
that loop:

- **at run open** — write the header: run id, pid, worktree, scope, requested
  set, ISO start.
- **at each check's settle** — append that check's untruncated block (result
  line, `ctx.log` observations, full message, hint) and re-write the file.
- **at terminal** — append the STOP banner / inconclusive note and a `done` line.

Extract `renderOutcomeBlock(outcome): string[]` for the settle-time write. The
console path keeps its own truncating render (`emit` / `emitDetail`): truncation
exists to protect an agent's context, and is a console concern only. `emit` loses
its `full.push` duty — the transcript writer becomes the file's only owner.

Written with `writeFileSync` (whole-file re-materialization), **not** an append:
`no-adhoc-file-sink` reserves append-mode writers for the file-sink primitive, and
`openDynamicSink` is a `.jsonl`-only, 128 MB-rotating shape that does not fit a
per-run text artifact. A full check run is ~155 lines, so re-writing on each
settle is cheap; the family's bound is the prune, as with every other per-run
artifact.

Consequence worth stating: the file is **completion-ordered** while the console
and `build.log` stay selection-ordered. That is the correct trade — the file is a
live log whose value is being readable mid-run.

### 1d. Call sites

Four, all currently spelling the filename by hand:

| file | change |
|---|---|
| [`commands/build.ts:1108`](../plugins/framework/plugins/cli/bin/commands/build.ts) (`fullChecksJob`) | `logRun: { worktree: name, runId: buildId }` |
| [`commands/build.ts:1224`](../plugins/framework/plugins/cli/bin/commands/build.ts) (`failBuild` pointer) | `worktreeArtifacts.checkLog(name, buildId)` |
| [`internal/app-artifacts.ts:474`](../plugins/framework/plugins/cli/bin/commands/internal/app-artifacts.ts) (`fastValidationJobs`) | `checkLogFile: string` → `checkLogRun: { worktree, runId }` |
| [`commands/check.ts:134,254,270`](../plugins/framework/plugins/cli/bin/commands/check.ts) | `logRun: { worktree: slug, runId: opId }`; final `Full check output:` line derives from the helper |
| [`commands/build-composition.ts:196`](../plugins/framework/plugins/cli/bin/commands/build-composition.ts) | `checkLogRun: { worktree: name, runId: buildId }` |

`opId` is already minted unconditionally at `check.ts:178` (it is shared with the
op-log record and the signal-origin sink line), so a push-nested check has one
too.

### 1e. The hole that let the hand-spelled path exist

`paths:no-inlined-worktree-artifacts`
([`paths/check/index.ts:100`](../plugins/infra/plugins/paths/check/index.ts))
already bans `"build.log"` but says nothing about `check.log` — which is why four
`join(worktreeDataDir(name), "check.log")` call sites were legal. Add:

```ts
{ pattern: /["'`]check(?:-[^"'`\s]*)?\.log/, grepArg: ".log" },
```

and name `check*.log` in the hint. The paths plugin itself and `research/` stay
exempt as they already are.

## Part 2 — a pointer always names a file that exists

### 2a. The build-logs artifact carries its own exit code

`readBuildTerminal` ([`run-build.ts:102-127`](../plugins/build/server/internal/run-build.ts))
infers the code from `steps.every(s => s.success)`. That inference is only safe
while the artifact is written exclusively at a *complete* terminal — the moment a
killed build writes a partial, all-green step list, it reads as **success**.

So before anything else writes on the abort path: add `exitCode: number` to
`BuildLogs` ([`bin/build-logs-writer.ts:13`](../plugins/framework/plugins/cli/bin/build-logs-writer.ts)),
stamped by whoever writes (0 on success, 1 / `BUILD_EXIT_SUPERSEDED` from
`failBuild`, `128+signo` on abort, the observed code in the backend backstop).
`readBuildTerminal` prefers `parsed.exitCode` and keeps the step-derivation as
the fallback for artifacts written before this change; its terminal test becomes
`finishedAt != null && (exitCode != null || steps.length > 0)`, so a
zero-step abort still counts as terminal. Update the docblock — it currently
asserts the CLI writes this file only on the two complete paths.

Bonus, and the reason this is the right shape: a killed build's row then closes
at `128+signo` with its real `finishedAt`, so `buildStatusOf` reports **killed**
instead of the `-1`/`now` sentinel — the same distinction commit `8402da4` just
drew for the notification.

### 2b. The guard that prints the pointer writes the file

`installVerdictGuard` ([`bin/build-output.ts:167`](../plugins/framework/plugins/cli/bin/build-output.ts))
gains `onFallback?: (verdict: Verdict, code: number) => void`, invoked
synchronously when a fallback verdict is produced **and nothing was emitted** —
i.e. exactly the arms where no transcript was written. (The two
contradiction arms already ran `writeBuildLogs`; re-writing them would only
churn the trailer.)

`build.ts` passes
`onFallback: (v, code) => writeBuildLogs(name, renderVerdict(v), code)`.
`writeBuildLogs` is fully synchronous (`writeFileSync` + `renameSync`), so it is
safe from an exit handler; it is registered after `finalizeBuild`'s hook, which
is the ordering already in place.

Net: printing `Full output: <path>` and materializing `<path>` become one
terminal action, on every path the CLI can take, whether or not a backend is
watching.

### 2c. The backstop writes the whole set

SIGKILL runs no handler, so `run-build.ts:345-372` stays as the recovery — but it
currently writes 1 of the 2 artifacts the transcript's own text points at. Pull it
into one helper (`recoverBuildArtifacts({ worktree, buildId, lines, finishedAt,
exitCode })`) that writes:

- `build-logs-<id>.json` — as today, plus the new `exitCode`, the same value the
  helper's caller stamps on the `build_runs` row, so artifact and row agree by
  construction;
- `build-<id>.log` — the captured lines verbatim, under a one-line
  `(recovered by the backend — this build was killed before writing its own
  transcript)` header;

each guarded by `existsSync` (never overwrite the CLI's own), each atomic
(`.tmp.<pid>` + rename), then the existing `pruneWorktreeBuildArtifacts`. One
helper so a future artifact cannot be half-written again.

## Tests

- [`bin/build-output.test.ts`](../plugins/framework/plugins/cli/bin/build-output.test.ts)
  — extend the existing "every non-null fallback's rendered last line is the Full
  output pointer" case: every fallback carrying that pointer must also invoke
  `onFallback`. That binds the pointer and the write together in one assertion.
- [`run-build.test.ts`](../plugins/build/server/internal/run-build.test.ts) —
  recovery writes **both** artifacts; `readBuildTerminal` prefers an explicit
  `exitCode`; a partial all-green step list with `exitCode: 143` reads as killed,
  not success; a pre-existing artifact is not overwritten.
- [`prune-artifacts.test.ts`](../plugins/infra/plugins/paths/server/internal/prune-artifacts.test.ts)
  — the check family keeps the newest N `check-<id>.log`, sweeps its `.tmp.<pid>`
  leftovers, does not touch the build/release families, and reaps a legacy
  `check.log`.
- A `bun:test` unit for `renderOutcomeBlock` (pure), so the transcript's per-check
  shape is pinned without loading the check registry.

## Verification

1. `./equin build` in this worktree. Confirm `check-<buildId>.log` sits
   beside `build-<buildId>.log` in `~/.singularity/worktrees/<wt>/`, opens with
   the run header, and that `check.log` is no longer written.
2. Break a check deliberately (e.g. a stray `check.log` literal, which should now
   fail `paths:no-inlined-worktree-artifacts`) and confirm the verdict's
   `Check logs:` pointer resolves to that build's file.
3. Kill a build mid-checks — `kill -TERM $(jq -r .pid ~/.singularity/worktrees/<wt>/build-status.json)`.
   Confirm: `check-<id>.log` holds a partial transcript of *that* run;
   `build-<id>.log` exists (written by the abort guard) and its
   `Full output:` pointer resolves; `/debug/build/r/<id>` shows the recovered
   steps; the run's status badge reads **killed**, not failed.
4. `./equin check` standalone → `check-<opId>.log`; the printed
   `Full check output:` path resolves.
5. `./equin test plugins/infra/plugins/paths plugins/framework/plugins/cli plugins/build`
   and `./equin check`.
