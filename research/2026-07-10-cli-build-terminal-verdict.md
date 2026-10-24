# `./equin build` must own its terminal verdict

## Context

A failed `./equin build` currently ends its log with vite's success line:

```
✓ built in 72m 13s

Build failed: checks
```

Nothing below `✓ built` states that the deploy was skipped. This has now misled at
least two agents into believing a build deployed when it had not
(`conv-1783448623-h424`, and again in the session that filed the task — which had
already *read* the earlier agent's description of the trap and still lost a full
build cycle to it). At 10–70 minutes per build, a misread failure is discovered
very late.

### Why it happens — three compounding causes

1. **Display order is push order, not outcome order.** `printStepResults`
   (`plugins/framework/plugins/cli/bin/commands/build.ts:251`) replays the
   buffered step transcripts in the order they were pushed into the `parallel`
   array (`build.ts:963-1067`): `checks` first, `viteBuild` **always last**.
   `Promise.all` preserves that order regardless of which step failed, so vite's
   chatty output is the last subprocess text on every failure.

2. **The failing step is the quiet one.** The checks runner deliberately
   summarizes its console lines (the full transcript goes to `check.log` —
   `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts:47,136-140`),
   so the step that failed is both *earlier* and *terser* than the step that
   passed.

3. **The build has no verdict of its own.** Success is signalled by the
   *presence* of three lines (`Registering worktree…` / `Restarting backend…` /
   `Deployed to <url>`); failure by their *absence*, plus one
   `console.error` on **stderr** reading `Build failed: checks`. That line names
   the failed step but never states the consequence — that nothing was deployed
   and the URL still serves the previous build. A reader scanning the tail sees a
   green `✓ built` in what looks like the build's own voice.

The structural fault: **the build's transcript is a concatenation of other
programs' transcripts, and it ends with one of theirs instead of one of its own.**

### On the reported exit code 0

The task reports "the exit code is also 0 in at least one observed failure path."
I could not reproduce this, and an exhaustive walk of every termination path in
`build.ts` and its callees (`exec`, `waitForPg`, `waitForDatabase`, `probeHealth`,
`acquireBuildLock`, `runChecks`, `generateMigration`, `checkBroadcasts`, the
signal handlers, the orphan watchdog) found **no exit-0 branch guarding a failure
condition**. Empirically, on this repo's pinned Bun 1.3.13, an unhandled rejection
from commander's un-awaited async `.action()` still exits 1. No caller masks the
code: the `./equin` wrapper `exec`s the CLI, and `run-build.ts:216` captures
`proc.exited` faithfully.

Two plausible explanations for the observation, both worth designing against:

- **A shell-pipeline artifact.** `./equin build | tail -50` reports `tail`'s
  status, not the build's. zsh has no `pipefail` by default.
- **A deliberate soft-warn degrade.** `probeHealth`'s non-restart deadline
  branches (`build.ts:564,585,592`) and `probeGatewayHealth`'s deadline
  (`build.ts:628`) print an alarming `console.warn` and then legitimately continue
  to a successful exit 0. Read out of context, that is "a failure that exited 0."

So rather than chase a phantom, this plan makes the exit code **self-reporting**:
the process cannot terminate without printing a verdict, and a verdict that
disagrees with the exit code prints a loud bug banner. If the exit-0 path is real,
the next occurrence names itself.

> Verified by probe: output written from a `process.on("exit")` handler — via both
> `console.log` and `fs.writeSync(1, …)` — survives `process.exit()` and reaches a
> **pipe** intact, even behind 5 000 lines of preceding output. Also verified:
> assigning `process.exitCode` inside that handler is **ignored** by Bun (observed
> exit stayed 0). The handler can therefore *guarantee a banner* and *detect* a
> wrong exit code, but cannot repair one.

### Intended outcome

- The last lines of a build are always the build's own verdict, never a
  subprocess's.
- A failure states its consequence in plain words (**NOT DEPLOYED**, which URL
  still serves what) and ends with the paths to the full logs.
- Every replayed subprocess line is visibly *quoted*, so no borrowed `✓` can be
  mistaken for the build's own.
- Terminating without a verdict, or with a verdict that contradicts the exit code,
  is loud rather than silent.

## Constraints discovered

- **Nothing in the repo regexes the build's stdout.** Not `run-build.ts` (it
  decides success purely from `exitCode`), not the gateway, not `e2e/`, not
  `.claude/`. Wording and ordering are free to change.
- **`StepResult` / `BuildStepLog` is load-bearing JSON.** `build-fix-section.tsx:63-69`
  filters `logs.steps` on `!s.success` to build the investigate-agent prompt, and
  `run-build.ts:67-85` (`resolveOrphanExitCode`) reads `steps[].success`. The
  verdict must **not** be smuggled in as a synthetic step. It goes into
  `build.log` as trailing text only.
- **`build.log`'s text render has the same trap.** `renderStepsText`
  (`build-logs-writer.ts:24`) also ends with the last step's lines, so anyone
  `cat`-ing the file hits the same illusion. It needs the verdict too.
- `printStepResults` (`build.ts:251`) and `renderStepsText` (`build-logs-writer.ts:24`)
  independently reproduce the same `── {label} {icon} ({duration}s) ─…` header.
  That duplication should collapse into one renderer as part of this change.
- **`push` does not have this bug** and is out of scope: it runs checks *before*
  any success-looking output and `process.exit(1)`s before printing `Pushing…` /
  `Done.` (`push.ts:426-440,537-552`).
- No colour/ANSI helper exists anywhere in the CLI (no chalk/picocolors). Stay
  plain-text + unicode box glyphs.

## Design

### 1. New module: `plugins/framework/plugins/cli/bin/build-output.ts`

Owns every byte the build prints about itself. Pure renderers, one impure emitter,
one exit-time guard.

```ts
export interface StepStatus { label: string; success: boolean }

export type Verdict =
  | { ok: true;  headline: string; notes: string[]; pointers: string[]; steps: StepStatus[] }
  | { ok: false; headline: string; reason: string[]; pointers: string[]; steps: StepStatus[] };

/** Quoted replay of one step. Shared by the console and by build.log. */
export function renderStepBlock(step: BuildStepLog): Array<{ text: string; stream: Stream }>;

/** Successes first, failures last. Stable within each group. Console/text only —
 *  never applied to the JSON `steps` array. */
export function orderStepsForDisplay<T extends { success: boolean }>(steps: T[]): T[];

/** Pure. Returns the full banner text. `pointers` are always the final lines. */
export function renderVerdict(v: Verdict): string;

/** Prints via fs.writeSync(1, …) and records that a verdict was emitted. */
export function emitVerdict(v: Verdict): void;

/** process.on("exit") backstop. Registered once, after `name`/`buildId` exist. */
export function installVerdictGuard(ctx: { url: string; buildLogPath: string }): void;
```

**Quoting.** `renderStepBlock` prefixes every replayed line with `│ ` instead of
today's two spaces. A borrowed `✓ built` then reads as `│ ✓ built`, unmistakably
inside a quoted block. `stream` is preserved per-line so stderr still goes to
stderr, exactly as today.

**The guard is the invariant.** It runs at `process.on("exit")` and covers all
~12 scattered `process.exit(1)` sites (branch guard, `exec`, `waitForPg`,
`waitForDatabase`, `probeHealth`, `generateMigration`, `checkBroadcasts`, SIGINT/
SIGTERM, the orphan watchdog) without touching any of them:

| emitted verdict | exit code | guard prints |
|---|---|---|
| `ok: true` | `0` | nothing (already printed) |
| `ok: false` | non-zero | nothing (already printed) |
| none | non-zero | `BUILD FAILED — aborted before completing (exit N)` + NOT DEPLOYED + pointers |
| none | `0` | `BUILD FAILED — exited 0 without deploying. This is a bug in build.ts.` |
| `ok: false` | `0` | `BUILD FAILED — the build failed but exited 0. This is a bug…` |
| `ok: true` | non-zero | `BUILD FAILED — reported success but exited N. This is a bug…` |

The last three rows are exactly the class the task reports. They cannot be
repaired from the handler (Bun ignores `process.exitCode` there — probed), but
they now name themselves instead of passing silently.

Register the guard **after** the existing `process.on("exit", () => finalizeBuildLog(false))`
(`build.ts:779`) so handlers run in order and the banner is the last thing written.

### 2. One fatal funnel in `build.ts`

```ts
function failBuild(reason: string[], failedLabels: string[]): never
```

Writes `build.log` (with the verdict as trailer), calls `finalizeBuildLog(false)`,
`emitVerdict({ ok: false, … })`, `process.exit(1)`. Replaces the ad-hoc
`console.error` + `process.exit(1)` pairs at `build.ts:1089-1101` (step failure),
`build.ts:549-557` (`probeHealth` hot-restart never became ready), and
`build.ts:1238-1244` (gateway reports `broken`). Earlier exits (`getWorktreeRoot`,
name validation, branch guard) fire *before* `name` and `buildId` exist and before
any artifact is touched, so there is no deploy ambiguity to resolve; they keep
their current plain `console.error` + exit 1 and the guard is simply not yet
installed.

### 3. Failure output shape

Console tail on a checks failure, with `--skip-checks` off:

```
── vite build ✓ (72.2s) ──────────────────────────────────
│ vite v6.0.1 building for production...
│ ✓ built in 72.2s

── checks ✗ (81.4s) ──────────────────────────────────────
│ ✗ type-check (3 errors)
│   plugins/foo/web/bar.tsx(12,7): error TS2345 …

╔══════════════════════════════════════════════════════════╗
║  BUILD FAILED — checks                                   ║
╚══════════════════════════════════════════════════════════╝
  NOT DEPLOYED. Nothing was published; http://att-x.localhost:9000
  still serves the previous build. The frontend compiled, but the
  artifact was discarded.

  checks ✗   vite build ✓

  Full output: ~/.singularity/worktrees/att-x/build.log
  Check logs:  ~/.singularity/worktrees/att-x/check.log
```

Three properties, each answering one of the three causes above:

- The failing step is **last** among the quoted blocks (cause 1).
- The banner **restates every step's status** (`checks ✗   vite build ✓`), so the
  tail alone carries the full truth even if the quoted blocks scroll away (cause 2).
- The banner states the **consequence**, not just the failed step name (cause 3).

Per the user's direction, `Full output:` / `Check logs:` remain the **literal last
lines**, so an agent reading only the tail still lands on the full transcript.
`Check logs:` is appended only when `checks` is among the failed steps (preserving
today's behaviour at `build.ts:1097-1099`).

Success is symmetric — same box, `BUILD OK — deployed`, the URL, the step roster:

```
╔══════════════════════════════════════════════════════════╗
║  BUILD OK — deployed                                     ║
╚══════════════════════════════════════════════════════════╝
  http://att-x.localhost:9000

  checks ✓   vite build ✓
```

**Both verdicts go to stdout** (user's choice). The build's own result can then
never be hidden by `2>/dev/null`, and it survives `| tail`. Error semantics stay
on the exit code, which is already correct. `fs.writeSync(1, …)` guarantees the
banner is not truncated by an immediately-following `process.exit()`.

### 4. Fold the soft-warn degrades into the success verdict

`probeHealth`'s lenient deadline branches (`build.ts:564,585,592`) and
`probeGatewayHealth`'s deadline (`build.ts:628`) currently `console.warn` something
alarming and then exit 0 having deployed — the second candidate explanation for
the "failure that exited 0" report. Thread their message into the success
verdict's `notes[]` so the terminal line reads:

```
║  BUILD OK — deployed (server still booting under host load)  ║
```

The warning keeps its place in the body; what changes is that the *verdict* now
absorbs it instead of leaving it as the reader's last impression.

### 5. `build.log` gets the verdict as a trailer

- `renderStepsText` (`build-logs-writer.ts:24`) switches to the shared
  `renderStepBlock` + `orderStepsForDisplay`, so the file matches the console.
- `writeBuildLogs(name, trailer?: string)` appends the rendered verdict after the
  last step block.
- The JSON `{ steps }` payload is **unchanged** — same order, same shape, no
  synthetic step. `resolveOrphanExitCode` (`run-build.ts:67`) and
  `build-fix-section.tsx:63` keep working untouched.

Chicken-and-egg: the verdict's pointers include `build.log`'s own path, and
`build.log` must contain the verdict. Resolve by computing the path up front from
the existing pure helper `worktreeArtifacts.buildLogText(name, buildId)`
(`bin/paths.ts`), rendering the verdict, then calling
`writeBuildLogs(name, verdictText)`.

## Files

| File | Change |
|---|---|
| `plugins/framework/plugins/cli/bin/build-output.ts` | **new** — `renderStepBlock`, `orderStepsForDisplay`, `renderVerdict`, `emitVerdict`, `installVerdictGuard` |
| `plugins/framework/plugins/cli/bin/build-output.test.ts` | **new** — `bun:test`, pure assertions |
| `plugins/framework/plugins/cli/bin/commands/build.ts` | `printStepResults` uses the shared renderer + display order; `failBuild()` funnel; `installVerdictGuard()` after `finalizeBuildLog`'s exit hook; success/`--no-restart` paths emit the OK verdict; soft-warn branches contribute `notes[]` |
| `plugins/framework/plugins/cli/bin/build-logs-writer.ts` | `renderStepsText` uses the shared renderer; `writeBuildLogs(name, trailer?)` |

Untouched by design: `run-build.ts`, `build-fix-section.tsx`, `build-log-section.tsx`,
`profiler.ts`, `build-log-writer-global.ts`, `push.ts`.

## Verification

**Unit** — `bun test plugins/framework/plugins/cli/bin/build-output.test.ts`
(prerequisite: `node_modules` populated, so run after a build or `bun install`):

- `orderStepsForDisplay` puts failures last and is stable within each group.
- A rendered failure verdict's **last two lines** are the `Full output:` /
  `Check logs:` pointers.
- A rendered failure verdict contains `NOT DEPLOYED`, the worktree URL, and a
  roster entry for every step.
- `Check logs:` appears only when a step with `id === "checks"` failed.
- `renderStepBlock` prefixes every line with `│ ` and preserves each line's stream.
- The guard's fallback text for `(no verdict, exit 0)` and `(ok:false, exit 0)`
  both contain `This is a bug`.

**End-to-end, failure** — reproduce the exact reported case (checks fail, vite
succeeds). Introduce a lint-only violation that vite happily compiles, e.g. a bare
`.catch(() => {})` in a web file (caught by `promise-safety/no-bare-catch`). Then:

```bash
./equin build 2>/dev/null | tail -8   # stdout only, mimicking the trap
echo "exit=${PIPESTATUS[0]}"
```

Expect: the tail is the `BUILD FAILED` box ending in the two pointer lines, with
no bare `✓ built` outside a `│ ` prefix; `PIPESTATUS[0]` is 1. Then confirm
`~/.singularity/worktrees/<wt>/build.log` ends with the same banner, and that the
build UI's Live log (`plugins/build/plugins/build-logs/`) shows the banner followed
by `run-build.ts`'s own `Build failed (exit 1)`.

**End-to-end, success** — revert the violation, `./equin build`, confirm the
tail is the `BUILD OK — deployed` box with the URL, `echo $?` is 0, and the app
serves at `http://<worktree>.localhost:9000`.

**Guard** — temporarily patch a `process.exit(1)` into the middle of the action
(after `installVerdictGuard`) and confirm the fallback
`BUILD FAILED — aborted before completing (exit 1)` banner prints. Revert.

## Non-goals

- Serializing checks before vite. They are parallel on purpose; the fix is to
  report honestly, not to slow the build down.
- Repairing a wrong exit code from the exit handler — proven impossible under Bun.
  The guard makes it loud instead.
- `push.ts`. It already fails before printing anything that reads as success.
- Colour output. No ANSI dependency exists in the CLI and none is added.
