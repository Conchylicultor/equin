import { rmSync } from "fs";
import { join, relative, resolve } from "path";
import { ensureParcelWatcherAddonLinked } from "@plugins/infra/plugins/file-watcher/plugins/parcel-addon/cli";
import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { readAwakeClock } from "@plugins/packages/plugins/sleep-clock/core";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import {
  withDirectOp,
  type DirectOpFlight,
} from "@plugins/framework/plugins/cli/plugins/op-runtime/cli";
import { cpuBudget } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import {
  getWorktreeRoot,
  spawnCaptured,
  spawnPassthrough,
} from "@plugins/infra/plugins/spawn/core";
import {
  worktreeArtifacts,
  worktreeDataDir,
} from "@plugins/infra/plugins/paths/core";
import { SAMPLE } from "@plugins/infra/plugins/paths/server";
import {
  LOOP_STOPPED_AFTER_MS,
  parseJunit,
  parseLoopHeartbeat,
  readTestStatus,
  testFailureLines,
  writeTestStatus,
  type TestRunnerName,
  type TestRunnerOutcome,
  type TestStatus,
} from "@plugins/framework/plugins/cli/plugins/test/core";
import { computeTreeHash } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  TEST_FILE_GLOB,
  isTestFilePath,
  partitionTestPaths,
} from "@plugins/framework/plugins/tooling/plugins/test-layout/core";
import {
  scanGlob,
  existsSync,
  readFileSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { tmpdirEnv, withRunTmpdir } from "./run-tmpdir";

// No args ⇒ every test in the repo. `plugins/` is the whole of it: both runners
// are scoped to that tree (vitest's `include` literally starts `plugins/**`).
const DEFAULT_TARGET = "plugins";

/**
 * One user-supplied path (file or directory), resolved to a repo-relative path
 * plus the repo-relative `*.test.ts(x)` files under it.
 *
 * The enumeration exists ONLY to classify — which runners have work — never to
 * be handed to a runner. Both runners take path filters of their own, so they
 * get `rel` and re-enumerate; see the action below.
 */
async function enumerateTests(
  root: string,
  target: string,
): Promise<{ rel: string; files: string[] }> {
  const abs = resolve(process.cwd(), target);
  if (!existsSync(abs)) {
    console.error(`No such path: ${target}`);
    process.exit(1);
  }
  // `""` is the repo root itself (`./equin test .`), which as a runner
  // path filter would match nothing rather than everything.
  const rel = relative(root, abs) || ".";
  if (rel.startsWith("..")) {
    console.error(`Path is outside the repo: ${target}`);
    process.exit(1);
  }

  if (statSync(abs).isFile()) {
    return { rel, files: isTestFilePath(rel) ? [rel] : [] };
  }

  const files: string[] = [];
  for await (const hit of scanGlob(TEST_FILE_GLOB, {
    cwd: abs,
    onlyFiles: true,
  })) {
    // `scan` walks into `node_modules`; a dependency's own test files belong to
    // neither runner's scope and would misreport both buckets.
    if (hit.split("/").includes("node_modules")) continue;
    files.push(join(rel, hit));
  }
  return { rel, files };
}

// Run one runner to completion, its output inherited (interleaving two runners'
// output would be unreadable, so the caller keeps these sequential). The banner
// is what makes a concatenated transcript attributable to a runner. `env`
// carries the host grant, so a runner that spawns workers of its own spends
// the units this op holds rather than acquiring host-wide again.
//
// `loop` (bun:test): the runner's event loop is watched through the preload's
// heartbeat (core loop-heartbeat.ts). A loop stopped for LOOP_STOPPED_AFTER_MS
// of awake time is a wedge nothing else can end — bun's own per-test timeout
// runs on that loop — so its stack is sampled into `loop.samplePath`, the
// runner is killed, and the run fails naming the sample. Never a wall-clock
// bound: a slow run whose loop turns runs as long as it needs.
async function runRunner(
  name: string,
  argv: string[],
  root: string,
  env: Record<string, string | undefined>,
  loop?: { heartbeatPath: string; samplePath: string },
): Promise<{ exitCode: number; wedged: string | null }> {
  console.log(`\n── ${name} ──`);
  // Set from `onSpawn`, a callback: a holder, so the reads below are not
  // narrowed to the initial null.
  const armed: { watch: LoopWatch | null } = { watch: null };
  try {
    const { exitCode } = await spawnPassthrough(argv, {
      cwd: root,
      env:
        loop === undefined
          ? env
          : { ...env, [envName("TEST_HEARTBEAT")]: loop.heartbeatPath },
      onSpawn: (child) => {
        if (loop !== undefined) armed.watch = watchLoop(name, child, loop);
      },
    });
    armed.watch?.cancel();
    return { exitCode, wedged: (await armed.watch?.end()) ?? null };
  } finally {
    armed.watch?.cancel();
  }
}

interface LoopWatch {
  /** The run is over: the sample path when it was declared wedged, else null. */
  end(): Promise<string | null>;
  cancel(): void;
}

/**
 * Arm the loop-stopped bound on a spawned runner: a one-shot timer, re-armed
 * from each heartbeat to fire when that beat turns LOOP_STOPPED_AFTER_MS old
 * (in awake time), never a poll. Where the awake clock does not exist (off
 * darwin) nothing is armed, and that is said once.
 */
function watchLoop(
  name: string,
  child: { pid: number; kill: (signal: NodeJS.Signals) => void },
  loop: { heartbeatPath: string; samplePath: string },
): LoopWatch {
  const spawnedAt = awakeNow();
  if (spawnedAt === null) {
    console.log(
      `(${name}: no awake clock on this platform — a stopped event loop is not detected)`,
    );
    return { end: () => Promise.resolve(null), cancel: () => {} };
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Settled into a result as it happens, so a sampler that threw is never an
  // unhandled rejection before the runner's exit lets `end` read it.
  let wedging: Promise<
    { ok: true; samplePath: string } | { ok: false; error: unknown }
  > | null = null;
  // A check that cannot read the heartbeat cannot vouch for the runner: it is
  // killed, and the run ends with that error (rethrown from `end`) — never an
  // uncaught throw in a timer, never a runner left unwatched.
  let broken: { error: unknown } | null = null;
  const lastBeat = (): number => {
    if (!existsSync(loop.heartbeatPath)) return spawnedAt;
    return parseLoopHeartbeat(readFileSync(loop.heartbeatPath, "utf8"));
  };
  const check = (): void => {
    timer = null;
    let idle: number;
    try {
      idle = (awakeNow() ?? spawnedAt) - lastBeat();
    } catch (error) {
      broken = { error };
      child.kill("SIGKILL");
      return;
    }
    if (idle < LOOP_STOPPED_AFTER_MS) {
      timer = setTimeout(check, LOOP_STOPPED_AFTER_MS - idle);
      return;
    }
    wedging = declareWedged(name, child, loop.samplePath, idle).then(
      (samplePath) => ({ ok: true as const, samplePath }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  };
  timer = setTimeout(check, LOOP_STOPPED_AFTER_MS);
  return {
    end: async () => {
      if (broken !== null) throw broken.error;
      if (wedging === null) return null;
      const wedged = await wedging;
      if (!wedged.ok) throw wedged.error;
      return wedged.samplePath;
    },
    cancel: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

function awakeNow(): number | null {
  const clock = readAwakeClock();
  return clock.supported ? clock.awakeMs : null;
}

/** Sample the stopped runner's stack, then kill it; resolves to the sample's path. */
async function declareWedged(
  name: string,
  child: { pid: number; kill: (signal: NodeJS.Signals) => void },
  samplePath: string,
  idleMs: number,
): Promise<string> {
  const minutes = (idleMs / 60_000).toFixed(1);
  console.error(
    `\n${name} (pid ${child.pid}) is WEDGED: its event loop has not turned for ${minutes} min of awake time, so no test timeout can fire. Sampling its stack to ${samplePath}, then killing it.`,
  );
  // `sample` is macOS's, as is the awake clock that got us here. Its failure
  // is reported (a non-zero exit) or rethrown (a spawn that threw) — and in
  // either case the wedged runner is killed first: the kill is unconditional.
  try {
    const sampled = await spawnCaptured(
      [SAMPLE, String(child.pid), "10", "-file", samplePath],
      { timeoutMs: 60_000 },
    );
    if (sampled.exitCode !== 0) {
      console.error(
        `(sample exited ${sampled.exitCode}${sampled.signalCode ? ` (${sampled.signalCode})` : ""}: ${sampled.stderr.trim()})`,
      );
    }
  } finally {
    child.kill("SIGKILL");
  }
  return samplePath;
}

/**
 * What one runner's exit and JUnit report say failed, as stable identities (see
 * `TestRunnerOutcome.failures`). The report is read and then deleted: the
 * outcome in `test-status.json` is the durable record, the XML only its source.
 */
function runnerOutcome(
  runner: TestRunnerName,
  exitCode: number,
  files: readonly string[],
  reportPath: string,
  wedged: string | null = null,
): TestRunnerOutcome {
  const failures: string[] = [];
  if (wedged !== null) {
    failures.push(
      `(${runner} wedged: its event loop stopped for ${LOOP_STOPPED_AFTER_MS / 60_000} min and it was killed; stack sampled to ${wedged})`,
    );
  }
  const unreported: string[] = [];
  if (existsSync(reportPath)) {
    const report = parseJunit(readFileSync(reportPath, "utf8"));
    rmSync(reportPath);
    failures.push(...report.failures);
    // A file that threw while loading never reaches the report — nor does one
    // that registered no cases — so all that can be said is that it is missing.
    const reported = new Set(report.files);
    unreported.push(...files.filter((file) => !reported.has(file)));
  }
  if (exitCode !== 0 && failures.length === 0)
    failures.push(`(${runner} exited ${exitCode})`);
  return { runner, exitCode, files: files.length, failures, unreported };
}

/**
 * The run-level single-flight for a test run: an identical `./equin test`
 * already in flight in this worktree — the same test FILES (however the paths
 * that selected them were spelled), on the same TREE — is joined instead of
 * run again. `undefined` (no flight) when the tree hash is unavailable
 * (`computeTreeHash` fails open): with no hash there is no correctness bar.
 *
 * The joiner writes its OWN `test-status-<opId>.json` — the leader's runners,
 * marked `adoptedFrom` — so `await` reads every test op's verdict the same way,
 * by its own id, and prints the failure summary `await` renders.
 */
function testFlight(
  files: readonly string[],
  targets: string[],
  treeHash: string | null,
): DirectOpFlight<"test"> | undefined {
  if (treeHash === null) return undefined;
  return {
    key: JSON.stringify({ files: [...files].sort(), treeHash }),
    adopt: ({ outcome, leader }, ctx) => {
      const ago = Math.max(
        0,
        Math.round((Date.now() - leader.startedAt) / 1000),
      );
      console.log(
        `Joined in-flight test ${leader.id} (same files, same tree, started ${ago}s ago) — its verdict: ${outcome}.`,
      );
      const led = readTestStatus(ctx.slug, leader.id);
      if (led === null) {
        // The verdict is still the leader's; only the detail is gone.
        console.error(
          `(the leader's test record is gone: ${worktreeArtifacts.testStatus(ctx.slug, leader.id)})`,
        );
        return outcome;
      }
      const now = new Date().toISOString();
      const own: TestStatus = {
        opId: ctx.opId,
        pid: process.pid,
        startedAt: now,
        targets,
        status: outcome === "success" ? "passed" : "failed",
        finishedAt: now,
        runners: led.runners,
        adoptedFrom: leader.id,
      };
      writeTestStatus(ctx.slug, own);
      for (const line of testFailureLines(own)) console.log(line);
      if (outcome !== "success") console.error("\nFAILED (adopted)");
      return outcome;
    },
  };
}

const run: CliAction<[string[]], object> = async (paths) => {
  const root = await getWorktreeRoot();
  const targets = paths.length > 0 ? paths : [DEFAULT_TARGET];

  // Classify first: which buckets have files decides which runners run at
  // all, and the counts are what the closing summary reports.
  const runnerArgs: string[] = [];
  // A Set, because overlapping args (`test plugins plugins/page`) enumerate
  // the same file twice and the runners deduplicate — the counts must too.
  const found = new Set<string>();
  for (const target of targets) {
    const { rel, files } = await enumerateTests(root, target);
    // Repo-relative rather than the literal argv the user typed, because
    // both runners are spawned with `cwd: root` (that is where bunfig.toml
    // and vitest.config.ts live). From the repo root — where the CLI is
    // normally invoked — the two are the same string.
    runnerArgs.push(rel);
    for (const file of files) found.add(file);
  }
  const { bun, dom, orphan } = partitionTestPaths([...found]);

  // A path in NEITHER runner's scope. `test-layout:runner-split` rule (c)
  // rejects these repo-wide, so this can only fire on a file the check has
  // not seen yet — and it must be loud, because such a file looks tested
  // and never runs. Refused HERE, before the op below: this is a
  // classification failure, not a test outcome, and it must not queue for a
  // host CPU slot (minutes, under load) just to be told the path was wrong.
  // Same for an empty selection.
  if (orphan.length > 0) {
    console.error(
      `\nIn neither runner's scope (these tests would NOT run):\n  ${orphan.join("\n  ")}\n` +
        "Run `./equin check test-layout:runner-split` for the rule.",
    );
    process.exit(1);
  }

  // Nothing to run at all. Reporting that as success would be the same lie
  // the command exists to prevent — a green result for tests that never ran —
  // so it is an explicit failure naming the paths (vitest's own default for
  // "no test files found" is likewise non-zero).
  if (found.size === 0) {
    console.error(`\nNo test files under: ${runnerArgs.join(", ")}`);
    process.exit(1);
  }

  // A test run is an OP, like a direct check: it takes a host CPU grant (its
  // queue time visible as a `host-grant` wait), plants the worktree op marker
  // (the conversation reads "working", the banner reads "Test in progress")
  // and lands an op-log record. The lifecycle is shared with `check` and
  // `run` — see op-runtime/cli/direct-op.ts; what is this
  // command's own is which runners to spawn and what their exits mean.
  //
  // The grant is the elastic share (the run's fan-out, at most `cpuBudget().B`,
  // is a ceiling; the acquire hands back what it could get, `>= 1`), and it is
  // spent by exactly ONE of
  // the runners. `bun test` runs its files in one process (`--parallel` is
  // opt-in, so there is nothing to bound); vitest's default `forks` pool is
  // sized to the core count, so `--maxWorkers=<units>` is what makes the
  // grant real. This asymmetry is deliberate — do not "fix" it into symmetry
  // by capping bun, which would cap nothing.
  // The tree hash, before the op: the run-level single-flight is keyed on it, and
  // a duplicate must find the in-flight run before it queues for a host slot.
  const treeHash = await computeTreeHash(root);

  const outcome = await withDirectOp(
    "test",
    {
      // The ceiling is the run's own fan-out, never more: bun:test is one
      // process (one unit), vitest one worker per file at most. Asking for B
      // regardless let a one-plugin run take every free slot and hold it while
      // using one core (2026-11-06: one test held all six background slots,
      // and a 1 s suite queued 4–6 min behind such holders).
      max: Math.max(1, Math.min(cpuBudget().B, dom.length)),
      flight: testFlight([...found], runnerArgs, treeHash),
    },
    // Every dir a test makes through `os.tmpdir()` lands in this run's own
    // scratch root, removed when the run ends — see run-tmpdir.ts.
    (grant, ctx) =>
      withRunTmpdir(async (scratch) => {
        const env = { ...process.env, ...grant.env(), ...tmpdirEnv(scratch) };
        // Suites load @parcel/watcher, whose patched index.js refuses to run
        // without the patched addon on darwin: an install since the last build
        // dropped it, so put it back first (one stat when it is there).
        await ensureParcelWatcherAddonLinked({
          root,
          log: (line) => console.log(line),
        });
        // The run's machine-readable record, written before either runner starts
        // so a killed run reads `running` rather than a previous run's verdict.
        // `toolchain upgrade` compares two of these, before and after.
        const { slug } = ctx;
        const status: TestStatus = {
          opId: ctx.opId,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          targets: runnerArgs,
          status: "running",
          finishedAt: null,
          runners: [],
        };
        writeTestStatus(slug, status);
        const bunReport = worktreeArtifacts.testReport(slug, ctx.opId, "bun");
        const domReport = worktreeArtifacts.testReport(
          slug,
          ctx.opId,
          "vitest",
        );

        const bunRun =
          bun.length > 0
            ? await runRunner(
                "bun:test",
                [
                  process.execPath,
                  "test",
                  "--reporter=junit",
                  `--reporter-outfile=${bunReport}`,
                  ...runnerArgs,
                ],
                root,
                env,
                {
                  // In the run's scratch root: gone with the run.
                  heartbeatPath: join(scratch, "bun-test-loop-heartbeat"),
                  samplePath: join(
                    worktreeDataDir(slug),
                    `test-wedged-${ctx.opId}-bun-sample.txt`,
                  ),
                },
              )
            : null;
        const bunExit = bunRun?.exitCode ?? null;
        // `bun x vitest` resolves the repo's own vitest and honors its
        // `#!/usr/bin/env node` shebang — the same runtime `bun run test:dom`
        // gives it. `vitest run` picks up the root `vitest.config.ts` from `cwd`.
        const domRun =
          dom.length > 0
            ? await runRunner(
                "vitest",
                [
                  process.execPath,
                  "x",
                  "vitest",
                  "run",
                  `--maxWorkers=${grant.units}`,
                  // `default` first: naming any reporter replaces vitest's
                  // console output unless it is named too.
                  "--reporter=default",
                  "--reporter=junit",
                  `--outputFile.junit=${domReport}`,
                  ...runnerArgs,
                ],
                root,
                env,
              )
            : null;
        const domExit = domRun?.exitCode ?? null;

        // The summary names BOTH buckets, always — an empty one is stated, never
        // implied by silence. That line is the whole reason this command exists:
        // `bun test <plugin-dir>` is green and partial in exactly the case where
        // this prints "no jsdom tests under this path".
        const where = targets.length > 1 ? "these paths" : "this path";
        const report = (
          label: string,
          exit: number | null,
          count: number,
          empty: string,
        ) =>
          console.log(
            exit === null
              ? `${label.padEnd(10)}${empty} under ${where}`
              : `${label.padEnd(10)}${count} ${count === 1 ? "file " : "files"}   exit ${exit}`,
          );
        console.log("");
        report("bun:test", bunExit, bun.length, "no bun:test files");
        report("vitest", domExit, dom.length, "no jsdom tests");

        const failed = [
          bunExit !== null && bunExit !== 0 ? "bun:test" : null,
          domExit !== null && domExit !== 0 ? "vitest" : null,
        ].filter((name): name is string => name !== null);
        if (bunExit !== null)
          status.runners.push(
            runnerOutcome(
              "bun:test",
              bunExit,
              bun,
              bunReport,
              bunRun?.wedged ?? null,
            ),
          );
        if (domExit !== null)
          status.runners.push(runnerOutcome("vitest", domExit, dom, domReport));
        status.status = failed.length === 0 ? "passed" : "failed";
        status.finishedAt = new Date().toISOString();
        writeTestStatus(slug, status);
        if (failed.length === 0) return "success";
        console.error(`\nFAILED: ${failed.join(", ")}`);
        return "failed";
      }),
  );
  if (outcome !== "success") process.exit(1);
};

export default run;
