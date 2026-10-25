// The one way to run a check pass from another op.
//
// `runChecks()` has exactly ONE in-process caller — the `check` command's own
// action. `build` and `push` both reach it through this helper, which spawns
// that command. That is what makes their two `checks ✓` the same claim.
//
// Why a fresh process, and not a function call:
//
//   • A passing check writes a durable entry to the GLOBAL cache at
//     `~/.singularity/check-cache/`, keyed on the working-tree hash and carrying
//     no provenance. A later push looks that hash up and returns ✓ without
//     running anything — so a recorded PASS is a TRANSFERABLE claim, and it is
//     only honest if the process that produced it did nothing but run checks.
//     A build's process has already imported every plugin barrel and run the
//     slot-declaration pass; a check that reads either sees a world no
//     standalone check can reproduce. Commit `fa7e865e0` shipped a
//     `docs/plugins-details.md` that only a build could regenerate, four
//     consecutive pushes hit the cached pass, and the failure surfaced hours
//     later on an unrelated branch (fixed at the source in `18126884a`).
//   • Push additionally needs the post-rebase code ON DISK, not the module cache
//     frozen at its own process start. Bun freezes a module on first `import()`,
//     so a rebase cannot invalidate anything the parent already loaded.
//
// **Selection is BY PROPERTY, never by id.** `select` carries flags, which the
// CHILD resolves against the registry. There is deliberately no `ids` field: an
// id list computed here would be a registry read performed in the very module
// cache the child exists to escape — the same mistake, one level up. Every
// selection is therefore hand-reproducible (`./equin check --scope tree`,
// `./equin check --always-run`) and its emptiness is noticed where it
// matters, inside `runChecks`.
//
// The three callers and what each asserts:
//
//   • `push` — `scope: "tree"`, live output. Deploy-scoped checks verify the
//     local gitignored dist that `build` produces: it never lands on main, and
//     push's own rebase moves the tree past it by construction, so a push can
//     only ever report the artifact as stale for having done its job.
//   • `build` (full pass) — `scope: ["tree", "deploy"]`. Build is the caller
//     that *can* assert `deploy`, because it is the one producing the dist. It
//     names both scopes rather than dropping the filter: "every scope" is not
//     the claim it is making, and while it WAS spelled that way build silently
//     took on `host` too — asserting the shared `~/.singularity` data root, and
//     so failing a deploy over a directory another agent's unmerged branch had
//     just declared.
//   • `build --skip-checks` — `alwaysRun: true`, the cheap structural subset.
//
// Nobody asserts `host` from an op. Its subject is the machine, shared with
// every checkout on the box; its home is a standalone `./equin check`.
//
// **`EQUIN_BUILD_IN_PROGRESS` must pass through untouched.** That marker
// is how a dist-comparing check (`web-artifacts:map-in-sync`) learns to skip a
// dist the build is about to replace; the child is the process actually running
// those checks, so it is the one that has to see it.
//
// **No `background` option, deliberately.** `type-check`'s workers already apply
// the agent-branch demotion rule at their own spawn site, so they are covered on
// every path; demoting the whole check subtree from here would be a behaviour
// change smuggled into a refactor.

import type { Grant } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import type { CheckScope } from "@plugins/framework/plugins/tooling/core";
import { readCheckProgress } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  spawnCaptured,
  spawnPassthrough,
} from "@plugins/infra/plugins/spawn/core";

export interface CheckSubprocessOptions {
  /** The checkout to check. Becomes the child's `cwd`. */
  root: string;
  /**
   * The host CPU grant this op already holds. Handed to the child via
   * `grant.env()`, whose `inheritedGrant()` rebuilds it and SPENDS those units
   * for its type-check fleet without re-acquiring host-wide — no double-acquire,
   * no deadlock, since the parent already holds the slots.
   */
  grant: Grant;
  /**
   * Selection BY PROPERTY ONLY, expressed here as flags and RESOLVED in the
   * child. Deliberately no `ids` field: a list computed in this process would be
   * read out of the very module cache the child exists to escape.
   */
  select?: { scope?: CheckScope | readonly CheckScope[]; alwaysRun?: boolean };
  /**
   * The caller's run id (`--run-id`), adopted by the child so `check-<id>.log`,
   * its progress records and its console all name the parent op. Omit it and
   * `spans` comes back empty — there is then no run id to attribute the child's
   * settle records to.
   */
  runId?: string;
  /**
   * `"inherit"` — the child writes straight to this terminal (push: live
   * streaming, unchanged).
   * `"capture"` — the output is buffered into `lines` (build: one step block
   * rendered at the end).
   */
  output: "inherit" | "capture";
}

export interface CheckSubprocessResult {
  ok: boolean;
  exitCode: number;
  /**
   * The child's output, one entry per line. Always empty for `"inherit"` — the
   * child wrote to the terminal, nothing was buffered.
   *
   * For `"capture"` every line is tagged `"stdout"`, because the capture MERGES
   * the child's two streams (see the spawn below). The per-line tag is the price
   * of true interleaving; the untruncated `check-<runId>.log` transcript keeps
   * the real distinction.
   */
  lines: Array<{ text: string; stream: "stdout" | "stderr" }>;
  /**
   * One entry per check that SETTLED, reconciled into THIS process's
   * `performance.now()` domain so a caller can draw them as bars in its own
   * timeline. Empty when no `runId` was given.
   */
  spans: Array<{ checkId: string; durationMs: number; wallStartMs: number }>;
  /** Peak RSS of the child (bytes), when the runtime reported rusage. */
  maxRssBytes: number | undefined;
}

/**
 * Run a check pass in a fresh process. Throws only on a spawn failure — see the
 * note at the call to `Bun.spawn`'s wrappers below.
 */
export async function runCheckSubprocess(
  opts: CheckSubprocessOptions,
): Promise<CheckSubprocessResult> {
  const { root, grant, select, runId, output } = opts;

  // Push's exact argv shape, and never a positional: a positional would be a
  // check ID, i.e. selection by id, which this helper does not do.
  const argv = ["bun", "plugins/framework/plugins/cli/bin/index.ts", "check"];
  if (select?.scope !== undefined)
    argv.push(
      "--scope",
      typeof select.scope === "string" ? select.scope : select.scope.join(","),
    );
  if (select?.alwaysRun === true) argv.push("--always-run");
  if (runId !== undefined) argv.push("--run-id", runId);

  // `process.env` values are `string | undefined`; the inferred spread type is
  // exactly what the spawn `env` contract accepts.
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...grant.env(),
  };
  // CLOCKS. `wallStartMs` has to be in THIS process's `performance.now()`
  // domain (the span collector subtracts its own `t0`), and the child's
  // `performance.now()` has a different origin. So take one paired reading here,
  // immediately before the spawn, and use epoch as the interchange.
  //
  // Never `performance.timeOrigin`: it bakes in a ~6 ms process-start capture
  // error, and across a process boundary it would do so twice. These two
  // readings are adjacent statements in one process, so the offset's error is
  // sub-millisecond against spans measured in seconds.
  const perfAtSpawn = performance.now();
  const epochAtSpawn = Date.now();

  // A spawn failure PROPAGATES, deliberately. `Bun.spawn` throws synchronously
  // on ENOENT; absorbing that into `ok: false` would report "checks failed" for
  // a machine that simply has no `bun`. A throwing job propagates out of
  // build's `Promise.all` exactly as a throwing `runChecks` did, and build's
  // exit backstop renders it as "aborted before completing".
  let exitCode: number;
  let maxRssBytes: number | undefined;
  const lines: CheckSubprocessResult["lines"] = [];
  if (output === "inherit") {
    const result = await spawnPassthrough(argv, { cwd: root, env });
    exitCode = result.exitCode;
    maxRssBytes = result.resourceUsage.maxRssBytes;
  } else {
    // `mergeStderr: true`, not two buffers. Two separate captures would split
    // the `• <id> … FAIL` line (stdout) from the message that explains it
    // (stderr) — precisely the pair a human reads together — into two blocks
    // separated by every other check's output.
    const result = await spawnCaptured(argv, {
      cwd: root,
      env,
      mergeStderr: true,
      // This child IS `./equin check` — the full type-check/lint/codegen
      // sweep. Its duration is the duration of the work, and nothing above it
      // owns a shorter deadline: the human at the terminal is the deadline, and
      // killing a check that was still making progress would only make the
      // command unusable. Bounding the pieces (each check's own git/worker
      // spawns) is where a real wedge is actually caught.
      unbounded:
        "this child is the whole `./equin check` run; its duration is the work's, and the CLI invocation above it owns no shorter deadline",
    });
    exitCode = result.exitCode;
    maxRssBytes = result.resourceUsage.maxRssBytes;
    for (const line of result.stdout.split("\n")) {
      if (line) lines.push({ text: line, stream: "stdout" });
    }
  }

  return {
    ok: exitCode === 0,
    exitCode,
    lines,
    spans:
      runId === undefined ? [] : readSpans(runId, perfAtSpawn, epochAtSpawn),
    maxRssBytes,
  };
}

/**
 * Read the child's per-check settle records back out of the durable progress log
 * and place each one on this process's monotonic clock.
 *
 * The progress log is the ONLY machine-readable channel here, on purpose: it is
 * written synchronously as each check settles, so a killed child still leaves
 * the checks it finished. A structured stdout summary would be written at the
 * end and lost in exactly that case — a killed child then draws a PARTIAL lane,
 * which is honest, and strictly better than the in-process pass it replaces
 * (which drew nothing at all when interrupted).
 *
 * DURATIONS COME VERBATIM FROM THE CHILD. The reconciliation places a span in
 * the lane; it can never resize one.
 */
function readSpans(
  runId: string,
  perfAtSpawn: number,
  epochAtSpawn: number,
): CheckSubprocessResult["spans"] {
  const run = readCheckProgress().find((r) => r.runId === runId);
  if (!run) return []; // the child never got far enough to record a settle
  return run.completed.map((c) => {
    // `at` is the settle instant, so `at - durationMs` is the start instant
    // EXACTLY — both come from the one `end` record, so they cannot disagree.
    const startEpoch = Date.parse(c.at) - c.durationMs;
    return {
      checkId: c.checkId,
      durationMs: c.durationMs,
      wallStartMs: perfAtSpawn + (startEpoch - epochAtSpawn),
    };
  });
}
