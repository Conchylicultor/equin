# test

`./equin test [paths...]` — runs the tests under the given paths with
**both** runners and reports on both.

The repo's test suites are split across two runners by file location:
co-located `*.test.ts(x)` go to `bun test`, `web/__tests__/` goes to
`vitest run`. The two scopes are exact complements (bunfig.toml's
`pathIgnorePatterns` against vitest.config.ts's `include`), which means either
runner on its own is *correct but partial* — it prints green while the other
half never ran.

So this command's real output is not the pass/fail, it is the two-line summary:
it names both buckets every time, including the empty one. "no jsdom tests
under this path" is the sentence that stops `bun test <plugin-dir>` from being
mistaken for a full run.

Three failures are explicit rather than implied:

- a test file in **neither** runner's scope (exit 1 — such a file looks tested
  and never runs; `test-layout:runner-split` rejects these repo-wide, so it can
  only be a file the check has not seen),
- **no** test files under the given paths (exit 1 — a green result for tests
  that never ran is the same lie the command exists to prevent),
- either runner exiting non-zero — exit **2** (`TESTS_FAILED_EXIT`): the
  tests ran and some failed, a verdict about the code, told apart from exit 1
  (the run could not be done) so a supervisor of runs (declared in `plugins/record`; Debug → Tests' Run now
  and idle batches, `verdictExits`) never files a verdict as a broken job.

It takes paths and nothing else. Every flag it could forward is a flag that
reaches one runner, and reaching one runner is the partial result above.

## A test run is an op

Like a direct `./equin check`, a test run takes a host CPU grant (its queue
time visible as a `host-grant` wait), plants the worktree op marker — the
conversation reads `working`, the banner reads "Test — Testing", or "Idle test run — yields to work" for
an opportunistic run (`EQUIN_OP_OPPORTUNISTIC`, see op-runtime) — and lands an
op-log record for the Ops Gantt. The lifecycle is `withDirectOp("test", …)` from
`op-runtime`, shared with `check` and `run`.

The grant is the elastic share (a ceiling of the run's own fan-out — one unit,
or one per vitest file, at most `cpuBudget().B`; the acquire hands back what it
could get) and exactly one runner spends it: `bun test` runs its
files in one process (`--parallel` is opt-in), so it is vitest's worker pool —
sized to the core count by default — that gets `--maxWorkers=<units>`. The
asymmetry is deliberate.

The two classification failures (a file in neither scope, no files at all) are
refused **before** the op, so a wrong path never queues for a host slot to be
told it was wrong.

## A runner whose event loop stopped is ended, loudly

bun enforces each test's timeout on the test process's own event loop, so a
test stuck in native code is never timed out — and a handed-off run then
lives forever: on 2026-11-09 a file-watcher run spun 31 h in a native addon
(the JS thread waiting in a destructor), holding its host CPU slot, until a
human killed it. So the bun:test preload stamps the **awake** clock into a
heartbeat file every 30 s (`EQUIN_TEST_HEARTBEAT`, set by this command), and
the runner arms a one-shot timer re-armed from each stamp: a loop that has not
turned for 10 min of awake time is wedged — its stack is `sample`d into
`test-wedged-<opId>-bun-sample.txt` in the worktree data dir, it is killed,
and the run fails naming the sample (`core/internal/loop-heartbeat.ts`).

The loop, never the wall clock: a wall-clock ceiling on an op misfired under
host duress and killed healthy builds
(`research/2026-07-28-global-retire-op-wedge-watchdog.md`); duress slows a
turning loop by seconds, and a slow run runs as long as it needs. Awake time,
so a machine that slept mid-run is not a stopped loop. darwin only (the awake
clock); elsewhere the run says it is not watched. vitest is not watched: its
tests run in its own worker pool.

## A run leaves no process behind

Each runner is spawned as the leader of its own process group
(`spawnPassthrough`'s `processGroup: "own"`, `infra/spawn`). Whatever a suite
starts — a helper server, a fixture's daemon, at any depth — stays in that
group, so when the runner exits whatever is still in it is killed (SIGKILL),
and if the CLI exits first its exit reaper kills the whole group. Before this
only the runner itself was reaped: on 2026-11-08 three helper servers a
failing `socket-client.test` never connected to sat reparented to pid 1 for
45 h.

What was killed is printed (`<runner> left N processes behind …`, pid and
command line) and recorded per runner as `leftBehind` in the run's record.
Not a failure — a helper a test is still tearing down can be caught mid-exit —
but each names a suite that leaks a process; fix that suite. The one way out of
the group is a descendant that starts its own session (`setsid` /
`detached: true`), which this repo sanctions only by exemption. A CLI killed
with SIGKILL runs no reaper: its runner and the runner's group outlive it.

## A run's scratch dirs die with the run

Both runners get `TMPDIR` (and `TMP` / `TEMP`) pointed at a run-scoped root,
`<os tmpdir>/equin-test-tmp/<pid>-<random>`, removed when the run ends
(`cli/run-tmpdir.ts`). Every dir a test makes through `os.tmpdir()` — a
fixture's `mkdtemp`, a spawn's capture dir, anything the code under test writes
— lands inside it, so a fixture needs no cleanup of its own for its dirs not to
outlive the run, and a runner killed mid-file leaks nothing. A run whose CLI
died before its `finally` is reclaimed by the next run's sweep (a root whose pid
is gone). A test that hardcodes `/tmp` escapes this — use `os.tmpdir()`.

## The run's record

Every run writes `test-status-<opId>.json` in the worktree data dir
(`worktreeArtifacts.testStatus(slug, opId)`: `running` at start, then the
verdict) listing each runner's failures as stable identities (`<file> > <suite>
> <case>`, or `(<runner> exited <n>)` when no failing case explains the exit),
plus `unreported`: files JUnit never mentions — a load crash and a file with no
registered cases look identical there. Both runners
write JUnit for it. Per-op, not one fixed file: concurrent runs used to
overwrite each other's verdict. `await` reads a run by its `opId`; the deps
upgrade gates, which spawn `test` and never learn the id, read the newest
(`readLatestTestStatus`). `toolchain upgrade` diffs two of these to tell a
regression from a failure that was already there. Pruned to the newest 50.

## Identical concurrent runs share one

Keyed on the resolved test FILES plus the tree hash (`withDirectOp`'s flight,
see `op-runtime/CLAUDE.md`): a duplicate joins the in-flight run instead of
queueing for a grant, writes its own record (the leader's runners,
`adoptedFrom: <leaderOpId>`), prints the same failure summary `await` renders
(`testFailureLines`), and exits with the leader's verdict.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: `./equin test` — the ONLY way to run tests: both runners (bun:test for co-located logic suites, vitest for jsdom suites), with a summary naming both buckets so a green-but-partial result is impossible.
- Core:
  - Uses:
    - `framework/cli/test/record.TEST_FAILURE_DETAIL_MAX`
    - `framework/cli/test/record.TestCaseFailure`
    - `framework/cli/test/record.TestFileResult`
    - `infra/paths.pruneWorktreeTestArtifactsSync`
    - `infra/paths.worktreeArtifacts`
    - `infra/paths.worktreeDataDir`
    - `packages/timed-fs.existsSync`
    - `packages/timed-fs.readdirSync`
    - `packages/timed-fs.readFileSync`
  - Exports (types):
    - `JunitFailure`
    - `JunitFileStats`
    - `JunitSummary`
    - `RunnerHarvest`
    - `RunnerHarvestInput`
    - `TestRunnerName`
    - `TestRunnerOutcome`
    - `TestStatus`
  - Exports (values):
    - `fileResults`
    - `formatLoopHeartbeat`
    - `JunitPathMismatchError`
    - `LOOP_HEARTBEAT_EVERY_MS`
    - `LOOP_STOPPED_AFTER_MS`
    - `parseJunit`
    - `parseLoopHeartbeat`
    - `readLatestTestStatus`
    - `readTestStatus`
    - `testFailureLines`
    - `writeTestStatus`
- Cli:
  - Uses:
    - `framework/cli/op-runtime.DirectOpFlight`
    - `framework/cli/op-runtime.withDirectOp`
    - `plugin-meta/plugin-records.openRecordStore`
- Cross-plugin:
  - Imported by:
    - `debug/tests`
    - `framework/cli/await`
    - `infra/deps/updates`
- Exemptions:
  - Exempts itself from:
    - `boundaries/no-platform-api` — `core/internal/test-status.ts` (debt)
    - `blocking-fs/sync-named` — `core/internal/test-status.ts` (sanctioned)
- Sub-plugins:
  - **`digest`** — The test digest: each test file's import-closure Merkle key plus its runner's inputs (plugin-records' module graph), the key a harvested `./equin test` verdict is stored under — and `./equin…
  - **`record`** — The test harvest's file formats, as zod schemas: TestRunRecord (one `./equin test` run's per-file verdicts under their digests, written to the host-global test-runs dir) and CheckoutDigests…

<!-- AUTOGENERATED:END -->
