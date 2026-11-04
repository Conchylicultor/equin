# Build logs: one record — the run transcript + exit marker

## Context

The build detail pane's Logs section (`build/build-logs`) showed build
`build-1793792825-0ew07t` as three green steps (197 lines) when the run printed
413 lines and exited 1 at the backend restart. Cause: two records of one build.

- **Step log** (`build-logs-<id>.json` + its text render `build-<id>.log`,
  2026-05-20, `op-runtime/cli/build-logs-writer.ts`). Holds only the step blocks
  the CLI pushes through `pushBuildStepLog` (checks, web artifacts, resource
  usage). Every serial line — registry, migrations, register, backend restart,
  health probe, the verdict banner — goes to stdout only. Also used as the
  ledger's terminal record (`readBuildTerminal`, `run-ledger/shared/stale-holder.ts`).
- **Run transcript + exit marker** (`runs/build-<id>.log` + `.exit-code`,
  2026-09-01, `supervised-job`). Complete, live while running, the shim's
  observed status — but only for builds the backend starts. A hand-run
  `./equin build` (every agent build) writes neither.

The pane prefers the incomplete step log whenever it has a step.

**Outcome:** the transcript + marker is the only build record, for every build.
Steps are read back from the transcript's own block format; the step-log files
and their writer are deleted.

## Design

### 1. Every build is a supervised run — the hand-run relay

New in `infra/jobs/supervised-job/cli`: `runAttached({ kindId, runId, argv, env })`
— the CLI-side twin of the backend's spawn, for a run whose caller stays attached:

- spawns `supervisedArgv(argv)` (the ONE shim; one marker writer) **detached**
  (own process group, as the supervisor does), stdout+stderr piped;
- copies every chunk to the transcript (`worktreeArtifacts.runTranscript`,
  opened `w`, merged like the supervised `2>&1`) and to its own stdout/stderr;
- forwards SIGINT/SIGTERM/SIGHUP to the child's group and keeps relaying until
  the child exits; an exit hook (the orphan guard's exit) SIGTERMs the group;
- returns the child's status; the caller exits with it.

`./equin build` (deploy posture, `framework/cli/plugins/build/cli/run.ts`):
first statement — when not already under a shim (`RUN_TERMINAL_ENV` unset), mint
the id and re-run itself through `runAttached` with `BUILD_ID=<id>` and a new
`BUILD_RELAYED=1` (env-names registry). `uiTriggered` (row pre-claimed by the
backend) becomes `BUILD_ID set && !BUILD_RELAYED`. Everything else in the build is
unchanged and runs once, in the child.

A SIGKILLed relay leaves the detached child running into a broken pipe; it
fails, the shim still writes its marker. Same honesty as today.

### 2. Steps parsed from the transcript

`op-runtime/core`: `parseStepBlocks(lines)` beside the format it reads —
`renderStepBlock`'s `── <label> ✓|✗ (<s>s) ──` header + `│ ` lines (move the
header/prefix spelling into one shared constant pair used by both). Lines outside
any block form an `output` segment (never dropped). Round-trip test against
`renderStepBlock`.

`build-logs` core schema: `success: boolean` → `status: "ok" | "failed" | "running"`,
`durationMs: number | null` (null = not measured — output segments).
Segment status: a block's own icon; an output segment is `ok`, except the
**last** one, which is `running` with no marker, and `failed` when the marker's
exit code ≠ 0 and no block failed (where the run ended is where it failed — this
run's backend-restart 500). `build-fix` reads `status === "failed"`.

`run-log.ts`: read transcript + marker only (`readRunTerminal`); delete the
artifact path, the JSON schema, the raw-step fallback. Memo signature over two
files.

### 3. Watching

`run-logs-value.ts`: keep `onSupervisedRunChange` (backend-tailed runs); replace
the data-dir watch on the JSON with a `children` watch on the runs dir filtered to
this run's transcript/marker basenames (a hand-run build the backend is not
tailing is heard at least when its marker lands).

### 4. Ledger terminal

`stale-holder.ts`: `readBuildTerminal` → the marker (`readRunTerminal`). Delete
`BuildLogsTerminalSchema`.

### 5. Deletions

- `op-runtime/cli/build-logs-writer.ts` (`pushBuildStepLog`, `writeBuildLogs`,
  `BuildLogs`); keep `BuildStepLog` as the step type in `build-output.ts`.
- `run.ts`: the writer calls, the `resourceUsage` synthetic step (its lines are
  already `console.log`ed), `onFallback`; the verdict pointer (`Full output:`)
  names the transcript.
- `paths`: `buildLogs`, `buildLogText`; the prune keeps reaping the legacy files
  by prefix so existing ones age out.
- Tests over the deleted files; docs/comments naming them.

## Verification

- `./equin test` on `build/build-logs`, `op-runtime`, `run-ledger`, `supervised-job`.
- `./equin check`.
- `./equin build` (hand-run → relay): `runs/build-<id>.log` + `.exit-code`
  exist, its stdout matches the transcript, no `build-logs-*.json` written.
- Pane at `/debug/build/r/<id>` on my build: every line, steps include the
  output segments, verdict from the marker; an old run (pre-change) still renders
  from its transcript, or refuses `missing` (hand-run, pre-change).
