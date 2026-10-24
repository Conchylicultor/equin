# Long-running work that survives a backend restart

**Status:** proposed
**Date:** 2026-09-01

## Context

A deploy of `website` failed on 2026-08-28 with the message `Exited with code 143`
(`drun-1787890652933-wr3v6d`). The root cause was not the remote host. An unrelated
`./equin build` of `main` finished mid-deploy; the gateway hot-restarts a backend by
signalling its **whole process group** (`gateway/worktree.go:584` → `killGroup` → `killPgid`),
and `run-deploy.ts` spawns the deploy CLI as a plain child, so it shares that group. It was
killed 0.9 s after spawning, during its pre-flight SSH check.

That is not a deploy bug. It is the third, worst copy of a problem this repo has already
solved twice — and each copy solved a different subset:

| | detached | pid on row | terminal artifact | boot reconcile | re-attach a live orphan |
|---|---|---|---|---|---|
| **build** | yes | yes | **written by the child**, at every terminal | yes | partial — a file-watcher closes the row, output is *not* restored |
| **release** | yes | yes | written by the **parent**, only on failure, only if it lived to see `proc.exited` | yes (pid-dead only) | no |
| **deploy** | no | no | no | no | no |

Two consequences beyond the incident:

- **Release's recovery is largely decorative.** `resolveOrphanExitCode`
  (`plugins/release/server/internal/run-release.ts:80`) reads an artifact that only the parent
  writes — so for a genuinely orphaned release there is nothing to read and the reconciler
  stamps the `-1` sentinel. Release also has no tests.
- **No backend can ever restore live output.** A pipe belongs to the process that created it.
  `log-channels`' ring buffer is process memory and is *never* seeded from its own `.jsonl`
  (`registry.ts:119`), and `publish()` is the only way a line ever reaches a WS subscriber.
  So today "survives a restart" means at best "the row gets closed later" — never "the user
  can still watch it".

**Intended outcome:** one primitive that owns detach + pid + transcript + reconcile + re-attach;
build, release and deploy migrated onto it; the two near-duplicate reconcilers deleted; and a
restart mid-run becomes invisible to the user rather than fatal.

## The design

Three concerns are tangled together today. Separating them is what makes the fix general.

### 1. The file *is* the stream — there is no "attached" mode to lose

The decisive change: **the child's stdout/stderr go to a file descriptor, not a pipe**, and the
supervisor publishes to the log channel by *tailing that file*.

This is not merely a durability trick. It removes the failure mode structurally (rung 1 of the
fix ladder): today there are two paths — a live path through the parent's pipe and a recovery
path through an artifact — and the recovery path is the one that rots, which is exactly what
happened to release. With a single path there is nothing to fall back to, so nothing can be
under-maintained. A restart stops being a special case: the boot tailer is the *same* code as
the spawn-time tailer, started at a different offset.

Change detection uses `@plugins/infra/plugins/file-watcher` with a debounce (the repo bans
polling; `watch-inflight-build.ts` is the precedent). The tradeoff is ~50–100 ms of added
latency versus a pipe, which is imperceptible for a build or deploy log.

**Accepted cost:** stdout and stderr merge into one transcript (`2>&1`), matching the existing
`mergeStderr` option in the spawn primitive. Interleaving order is preserved; the stdout/stderr
*classification* is lost, so every line is published as one stream. `verb-outcome.ts`'s refusal
picking already scans lines for the `deploy: ` prefix and is unaffected; its "last non-blank
stderr line" fallback becomes "last non-blank line". Two files with two tailers would keep the
classification but destroy ordering, which is worse. **Verify during implementation whether any
UI styles stderr lines differently before committing to this.**

### 2. The exit code is captured by the spawn, not by the command

Build's artifact works because the build CLI cooperates (`build-logs-writer.ts` writes
`{steps, finishedAt, exitCode}` at every terminal). Deploy's and release's CLIs do not, and
teaching all three CLIs the same trick is three places to get it right.

Instead the primitive wraps every argv in a one-line POSIX shim that records the status:

```sh
trap 'g=TERM; i=1' TERM; trap 'g=INT; i=1' INT; trap 'g=HUP; i=1' HUP
"$@" & c=$!
wait "$c"; s=$?
while [ "$i" = 1 ] && kill -0 "$c" 2>/dev/null; do i=0; wait "$c"; s=$?; done
[ -n "$g" ] || g=-
printf '%s %s\n' "$s" "$g" > "$T.tmp.$$" && mv "$T.tmp.$$" "$T"; exit "$s"
```

*(Transcribed from the implementation, which is authoritative — see
`core/internal/shim.ts`. Do not hand-edit this block; it has been wrong once already.)*

with `T` passed via env. This works for **any** command — deploy needs no CLI change at all —
and makes "forgot to record the exit code" unspellable rather than a convention.

> **Corrected as-built — three separate defects, all found by measurement, not reading.**
>
> 1. This document first proposed `'"$@"; printf %s $? > "$T.tmp" && mv "$T.tmp" "$T"'`. That
>    runs the child in the *foreground*, so SIGTERM's default disposition kills the shell
>    outright, no marker is written, and a cancelled run is indistinguishable from a hard
>    SIGKILL. The child must be backgrounded and `wait`ed, with one trap per signal.
> 2. **Traps must be installed BEFORE the child is backgrounded.** Between `&` and the first
>    `trap` the shell still has the default disposition, and a group signal landing in that
>    window loses the marker. Microseconds wide, zero cost to close. Safe because a signal
>    trapped to a *handler* is reset to default in the child — only `trap ''` is inherited.
> 3. **A trapped signal makes `wait` return `128 + signo` immediately — the child has NOT
>    necessarily exited.** Measured against a child that traps TERM and exits 42 after a moment
>    (exactly what `./equin build` does via `installFatalSignalExit`): the single-`wait`
>    form recorded `143 TERM` *while the child was still alive*, reparented and unwatched, and
>    threw away the status it was about to produce. With the retry: `42 TERM`, child already
>    gone. The `kill -0` guard is load-bearing — a second `wait` on an already-reaped pid
>    returns 127 and prints `wait: pid N is not a child of this shell` into the transcript.
>
> Defect 3 is the same class of bug this entire plan exists to fix: a terminal outcome reported
> for work that had not terminated.

**The marker records the signal NAME, not just the status** (`0 -`, `143 TERM`). This is not in
the original API sketch below and is load-bearing: `128 + signo` cannot tell a kill from a
program that chose `exit(143)` — they are the same number, and that ambiguity is exactly what
recorded `drun-1787890652933-wr3v6d` as `Exited with code 143`. So killed-ness is *observed*
(the trap fired), never *derived* from `exitCode > 128`, in the shim or in any consumer. The
shim deliberately does **not** fall back to `kill -l $((s-128))` when the trap did not fire:
that looks like a free second source and is the original guess one layer down, turning a genuine
`exit 143` into `signalCode: "TERM"`.

The **finish instant is the marker file's mtime**, not `new Date()` at reconcile time. Build
went out of its way to recover the true instant (`run-build.ts:86`, "Reusing `new Date()` at
reconcile time instead would inflate the row's Duration"); release does not and is wrong for it.
mtime gives every kind the correct answer for free, with no date formatting in `sh`.

No marker file ⇒ the child was hard-killed (SIGKILL runs no shell) ⇒ the `-1` sentinel, exactly
as build does today.

### 3. Claim, pid, reconcile — copy build's shape verbatim

Build's ordering is subtle and correct, and must be reproduced rather than reinvented:

1. INSERT the row **before** spawning, seeded with `pid: process.pid` (the backend's own, live
   pid). A partial unique index on `(scope) WHERE finished_at IS NULL` is the real lock — the
   claiming INSERT wins or loses, closing the check-then-act TOCTOU window. The seeded pid keeps
   the row from looking like an orphan during the window before the child's pid is known.
2. Spawn detached, then UPDATE the row to the child's pid.
3. At boot, per unfinished row: `close? = !(terminal == null && isPidAlive(pid))`.

Deploy currently has *no* durable lock at all — `runningOnServer` is an in-memory `Map`
(`run-state.ts:37`), so its "one run per server" promise already evaporates on restart. It gains
a partial unique index on `(server_id) WHERE finished_at IS NULL`.

### 4. Re-attach

At boot, for each unfinished row the primitive branches on pid liveness:

- **alive** → start a tailer from offset 0, republish the transcript into the channel, and call
  the kind's `onReattach` so it can restore its in-memory live view. The run reappears in the UI
  as running, with output still scrolling.
- **dead** → read the exit marker, stamp the terminal outcome, done.

There is no precedent for rebuilding a push-resource `Map` from **DB rows**, but there is a clear
one for rebuilding from the **filesystem** — `op-status`'s `worktreeOpsResource` recomputes from
marker files on every load, and `prototypes/thumbnails/state.ts` is documented as "free to rebuild
at boot, and impossible to leave stale". This follows that idiom.

## API

New plugin: **`plugins/infra/plugins/jobs/plugins/supervised-run/`** — a child of `jobs`, not a
38th flat sibling under `infra`.

Both plugins answer one question — *how does durable background work run* — and split only on
whether it must outlive the process. `jobs` already carries a sub-plugin (`deadline-audit`), so
the umbrella exists, and the declared destination is that `jobs` absorbs this as a process
execution mode (see Out of scope). Naming it here now makes that a change *inside* the jobs
subtree rather than a plugin move that churns the import path in build, release and deploy.

The honest cost: consumers import
`@plugins/infra/plugins/jobs/plugins/supervised-run/server`, which reads as a dependency on the
job system when there is none — this plugin needs `spawn`, `paths`, `file-watcher`,
`log-channels` and `db`, and never graphile-worker. Nesting is organisational and creates no
edge, but the path cannot say so. Accepted: the alternative pays that same cost later *plus* a
rename. There is no cycle risk either way — a later `jobs` → `supervised-run` import is an
ordinary parent-to-descendant edge (the umbrella rule bans *re-exports*, not imports).

`core/` is Node-only (no `db`), so a CLI process can import it:

```ts
export interface RunTerminal { exitCode: number; finishedAt: Date; }
export function readRunTerminal(kindId: string, runId: string): RunTerminal | null;
export function isPidAlive(pid: number | null): boolean;   // consolidates 2 hand-rolled copies
export function supervisedArgv(argv: readonly string[]): { argv: string[]; env: Record<string,string> };
```

`server/` owns the registry and the supervisor:

```ts
export function defineSupervisedRunKind(kind: {
  id: string;                                   // "build" | "release" | "deploy"
  channel: LogChannel;                          // where the tailer publishes
  listUnfinished(): Promise<readonly { runId: string; pid: number | null }[]>;
  setPid(runId: string, pid: number): Promise<void>;
  finish(runId: string, terminal: RunTerminal): Promise<void>;
  onReattach?(runId: string): void;             // restore the live view
}): SupervisedRunKind;

export function startSupervisedRun(
  kind: SupervisedRunKind,
  opts: { runId: string; argv: string[]; cwd?: string; env?: Record<string, string> },
): Promise<{ pid: number }>;
```

Each plugin keeps its **own** ledger table — `build_runs`, `release_runs` and `deploy_runs` carry
genuinely different domain columns, and merging them would be wrong. The kind is the adapter over
the caller's table, so the primitive names no consumer (collection-consumer separation).

**The reconciler is registered once, not per plugin.** `supervised-run`'s own `onReady` loops
every registered kind. `defineSupervisedRunKind` should be a `register:` token (like `defineJob`)
so registration is complete before `onReady` runs. This is where the duplication actually dies:
`reconcileOrphanBuilds` and `reconcileOrphanReleases` are deleted, not generalised in place.

**Artifact paths** go in `worktreeArtifacts` (`plugins/infra/plugins/paths/core/internal/paths.ts`),
never hand-joined — `runTranscript(worktree, kindId, runId)` and `runTerminal(...)`, alongside the
existing `buildLogs` / `releaseLogs` entries, with a matching prune helper.

## Files

**New:** `plugins/infra/plugins/jobs/plugins/supervised-run/{core,server}/` plus tests.

**Modified:**
- `plugins/apps/plugins/deploy/plugins/deployments/server/internal/run-deploy.ts` — `spawnVerb`
  becomes a `startSupervisedRun` call; the pipe-streaming loop is deleted.
- `.../deployments/server/internal/run-state.ts` — the kind definition; `onReattach` repopulates
  the `runs` map; `runningOnServer` reads the DB.
- `.../deployments/server/internal/tables.ts` — add `pid`, the partial unique index.
- `plugins/build/server/internal/run-build.ts`, `plugins/release/server/internal/run-release.ts` —
  same migration; delete both reconcilers, `resolveOrphanExitCode`, `recoverBuildArtifacts`, and
  `watch-inflight-build.ts` (the tailer subsumes it).
- `plugins/build/server/index.ts`, `plugins/release/server/index.ts` — drop the `onReady` wiring.
- `plugins/infra/plugins/spawn/lint/index.ts` — `supervised-run` becomes the one sanctioned
  `detached: true` site; remove the build/release/deploy entries as they migrate.

## Risks and open decisions

- **Transcript growth — DECIDED, as two separate bounds.** *Published* bytes are capped at
  `TRANSCRIPT_CEILING_BYTES` (16 MiB) per run, after which the tailer emits one "transcript
  truncated" line and goes quiet — this protects the log channel's ring and its `.jsonl` sink.
  *On disk* is capped by a write-time prune keeping the newest 50 run sets **per kind** per
  worktree (per-kind so a busy afternoon of builds cannot reap the one deploy transcript someone
  is reading), following the `pruneWorktreeBuildArtifacts` precedent. `defineRetention` turned
  out not to apply at all: it is a nightly `DELETE` over a *table*, and these are files.
  **Residual, accepted:** a single in-flight run's transcript file is bounded only by that run.
  It is a kernel fd the child owns, and capping it mid-run would race the writer.
- **A detached child can outlive its worktree checkout and DB fork.** Builds and releases already
  have this exposure; making deploy detached widens it. Worth a boot reaper that kills a child
  whose deployment row or checkout is gone — but that is a separate change, not folded in here.
- **Merged stdout/stderr** — see §1; verify the UI first.
- **Cancellation** becomes "signal a pid", not "abort a promise". The primitive should expose
  `killSupervisedRun(kind, runId)` rather than leaving each caller to reinvent it.

## As built — Phase 1 (2026-09-01)

The primitive is implemented at `plugins/infra/plugins/jobs/plugins/supervised-run/`; its own
`CLAUDE.md` is the maintained reference and supersedes the API sketch above where they differ.
Beyond the corrected shim and `signalCode` (both above), the departures from this document:

- **`supervisedArgv(argv, terminalPath)`** takes the marker path, and returns `{argv, env}`
  together so a caller cannot take one and forget the other — which would write the marker to the
  filesystem root and report every run as hard-killed.
- **`readRunTerminal` throws `RunMarkerError`** on a marker that exists but does not parse.
  Absent still returns null; a malformed one is a writer defect, and `null` would file it under
  "hard-killed" behind a plausible `-1` (the repo's absorbed-failure rule).
- **`envOverrides`, not `env`** — the neighbouring `spawnCaptured`'s `env` is a *full
  replacement*, and assuming that contract here would strip the backend's environment.
- **`killSupervisedRun` returns a discriminated `KillOutcome`** (`not-running` / `no-pid` /
  `already-exited` / `ok`), and signals the process **group**: the shim forwards nothing, so
  signalling it alone would kill the supervisor and leave the work running, reparented.
- **Artifacts live in a `runs/` subdirectory** — one `file-watcher` subscription serves every
  live run, and pointed at the bare data dir it would wake on every build profile and check
  transcript in the worktree. Suffixes are exported from `paths` because the supervisor parses
  filenames *backwards*; a private copy is where a layout change would silently stop every run
  from closing. Two `paths:no-inlined-worktree-artifacts` patterns cover the new family.
- **Kind ids may not contain `-`** (`assertRunKindId`, throwing at module eval). The id is the
  filename prefix and the prune splits kind from run at the first `-`, so `deploy` + `deploy2`
  would make pruning one reap the other's transcripts. Unspellable rather than documented.
- **`assertRegistered` guards `startSupervisedRun`** — a kind defined but never mounted in
  `register:` would start runs this plugin's `onReady` never reconciles, leaving rows open
  forever with no symptom at the call site.
- **Reconcile failures are isolated per kind AND per run**, both reported, neither rethrown.
  This is the *one* reconciler for every kind, so isolation is a requirement the per-plugin
  reconcilers never had; without the per-run arm a single corrupt marker strands every other run
  of its kind.
- **The reconciler untracks live runs the ledger no longer lists** — the caller's own CLI
  stamping its row is the ordinary case, and without this the live set only grows, the tail
  leaks, and the watcher never stops.

- **SIGINT is recorded but cannot cancel a run** — a POSIX property, not a choice. A
  non-interactive shell sets SIGINT to *ignore* for the commands of an asynchronous list, and an
  ignore disposition survives `exec`. Measured: a child sent a group SIGINT ran to completion and
  a child with its own INT trap never saw it fire. The run therefore closes with
  `exitCode: 0, signalCode: "INT"` — both facts true, nothing orphaned. Dropping the INT trap
  would be worse (the shim dies, no marker, the run reports as a hard kill). `killSupervisedRun`
  defaults to SIGTERM, which does reach the child; **do not reach for INT expecting it to stop
  anything.**

Measured matrix on real `/bin/sh`: graceful-TERM `42 TERM` · plain-TERM `143 TERM` ·
HUP `129 HUP` · INT `0 INT` (ignored) · KILL no marker · `exit 0/7/127` → `N -` ·
`exit 143` → `143 -`. No orphans in any case.

Status: **Phase 1 complete and verified** — 44 tests pass, repo-wide `type-check` ok across all
7 targets, prettier clean.

## As built — Phases 2a / 2b

**2a (deploy)** — deployed, migration `deploy_runs_supervision` applied. Deploy needed a
`launched_from` column and a `leg_run_id` column the plan did not anticipate: the primitive names
*legs*, `deploy_runs` names *runs*, and an `update` is two spawns with an in-process release
between them. Leg ids are `<runId>.converge` / `<runId>.ship`. The in-flight index is
`(launched_from, server_id)`, not `(server_id)` — cross-namespace exclusivity was never
enforceable (each namespace has its own DB fork, so an index cannot span them), and leading with
the launcher stops a `running` row inherited from main at fork time wedging a worktree forever.

**2b (build + release)** — `run-release.ts` 434 → 160 lines, `run-build.ts` 536 → ~155. Neither
needed a schema change; both ledgers already carried `namespace`, `pid` and a namespace-scoped
partial unique in-flight index. **Deleted:** `reconcileOrphanBuilds`, `reconcileOrphanReleases`,
`resolveOrphanExitCode`, `watch-inflight-build.ts`, both hand-rolled `isPidAlive` copies, both
pre-flight liveness probes (`hasLiveInflightBuild`, `isAnyReleaseAlive` — the claiming INSERT is
the lock, so losing the race *is* the answer), `readBuildTerminal`, `recoverBuildArtifacts`.
`supervised-run` is now the only `detached: true` entry in the spawn lint ignores.

### The second primitive defect, found by build

**`finish` could never fire for a kind whose CLI stamps its own ledger row while its process keeps
running.** The reconciler untracked a run the moment the ledger dropped it, which stopped the tail
and, once it was the last live run, tore down the watcher — so the exit marker landing afterwards
reached nobody. Build's CLI stamps `build_runs` right after the health probe and then runs another
~100 s of compose-serve tail (measured 75.8 s), so with a 60 s reconcile tick this happened
essentially every time. Two losses, and the worse one is not build-specific: **the rest of the
live log, silently truncated, for any kind that stamps early.**

The fix is that the untrack condition was stronger than the bound it wanted — it wanted the run to
have *ended*, not its row to have been *stamped*. Expressed by deleting the duplicate rather than
adding a condition: dropped runs now go through `settleRun`, which already holds the close rule,
already drains before `finish`, and already calls `finish` on every path. `untrack` has exactly
one caller. `LiveRun` gained a mutable `pid`, because the pid is precisely what the ledger stops
answering at the moment it drops the row.

**`finish` therefore means "the run ENDED", not "you are the one closing the row."** An
implementation must be first-writer-wins about its write and correct against an already-stamped
row. All three consumers were verified against that.

### Two things the plan got wrong, for the record

- **The await seam does not generalise.** Deploy and release each hand-rolled a waiter map, which
  looked like a missing primitive API. With build in view it is not: deploy needs per-leg *and*
  per-run, release collapses to one map, and build needs none (`triggerBuild` is `void` at every
  call site; it only *looked* like it needed one because it awaited `proc.exited` to do terminal
  work — the exact await a build kills). Two consumers, different shapes. Not extracted.
- **`build-logs-<id>.json` splits, it does not move.** The terminal record goes to the exit marker;
  the *step transcript* does not move at all, because the CLI writes it from inside the child.
  `recoverBuildArtifacts` is deleted and its recovery moved from the **write** path to the **read**
  path — the step view is synthesised from the child's own transcript with success taken from the
  marker. Strictly better: the old backstop required the *parent* to have survived, and a build
  restarts its parent.

## Verification

1. **Unit** — mirror `run-build.test.ts`'s structure: it cannot point the module-level `db` at a
   fixture, so it tests the *pure* decision functions against real files and real pids. Cover
   `readRunTerminal` (present / absent / unparseable / mtime-as-finish), `isPidAlive` (own pid, a
   reaped child), and the `close?` composition. Release has no tests today; this gives it some.
2. **The incident, reproduced** — start a deploy `update`, run `./equin build` while its
   release leg is running, and assert the deploy still reaches `succeeded`. This is the exact
   sequence that produced `drun-1787890652933-wr3v6d`, and it currently fails 100% of the time.
3. **Re-attach, visually** — start a long run, restart the backend, confirm the UI still shows it
   running with output scrolling. Drive it with an `e2e/` script under the deploy plugin
   (`plugins/apps/plugins/deploy/plugins/deployments/e2e/`).
4. **Ledger** — `query_db` on `deploy_runs` / `build_runs` / `release_runs`: no row left at
   `running` with a dead pid, and `finished_at` reflects the child's real finish, not the
   reconcile instant.

## Out of scope

Folding this into `jobs` as a process-execution mode, which would add dedup, serial queues,
retries and cron to all three callers. `RegisteredJob.run` is typed as an in-process closure
today, so that is a change to load-bearing dispatch and lock recovery. This primitive is the
prerequisite and should land and settle first.

Filed as **`task-1788260211030-g47x1v`** ("Out-of-process background work can't use the job
system"), a follow-up of the task this document came from — so it stays blocked until this
lands.

A boot reaper for children that outlive their checkout or deployment row (see Risks) is also
deliberately separate.
