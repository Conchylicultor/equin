import { SAMPLE } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import {
  CHECK_PASS_HUNG_KIND,
  CheckPassHungPayloadSchema,
  checkPassHungMessage,
  type CheckPassHungPayload,
} from "@plugins/reports/plugins/check-thread-stall/core";
import { fileReportFromProcess } from "@plugins/reports/plugins/outbox/plugins/file/core";
import { checkProgressLogDir } from "../../data-dirs";
import { mainThreadOfSample, type HangWatchData } from "../../core/hang-judge";
import { readCheckProgress, writeHungRecord } from "../../core/progress-log";

// What the hang watch's worker does with a verdict (`scripts/hang-watch-worker.ts`),
// before it kills the process: capture the native stack, read what was in
// flight back from the run's own progress records, write the `hung` record and
// file the `check-pass-hung` report. Runs on the worker thread — the main
// thread is the one that is stuck.

/** The capture `sample` takes of the hung process, in seconds. */
const SAMPLE_SECONDS = 3;

/** Bound on `sample` itself: it attaches to a 2 GB process under load. */
const SAMPLE_TIMEOUT_MS = 60_000;

/** The main thread's call tree lines the report keeps. */
const MAIN_THREAD_LINES = 40;

async function captureNativeStack(
  pid: number,
): Promise<CheckPassHungPayload["nativeStack"]> {
  if (process.platform !== "darwin")
    return {
      captured: false,
      reason: `no native stack sampler wired on ${process.platform} (macOS \`sample\` only)`,
    };
  await checkProgressLogDir.ensure();
  const file = checkProgressLogDir.file("hang-sample.txt");
  const result = await spawnCaptured(
    [SAMPLE, String(pid), String(SAMPLE_SECONDS), "-file", file],
    { timeoutMs: SAMPLE_TIMEOUT_MS },
  );
  if (result.timedOut)
    return {
      captured: false,
      reason: `sample timed out after ${SAMPLE_TIMEOUT_MS} ms`,
    };
  if (result.exitCode !== 0)
    return {
      captured: false,
      reason: `sample exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
    };
  const mainThread = mainThreadOfSample(
    await readFile(file, "utf8"),
    MAIN_THREAD_LINES,
  );
  return mainThread.length > 0
    ? { captured: true, file, mainThread }
    : { captured: false, reason: `no main-thread call tree in ${file}` };
}

/** What was in flight, from the run's progress records — the main thread's own account up to the hang. */
function inFlight(
  runId: string,
): Pick<
  CheckPassHungPayload,
  "running" | "bootstrap" | "lastStarted" | "settled" | "selected"
> {
  const run = readCheckProgress().find((r) => r.runId === runId);
  if (run === undefined)
    throw new Error(
      `hang-watch: run ${runId} has no records in the check progress log`,
    );
  const newest = [...run.outstanding].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  )[0];
  return {
    running: run.outstanding.map((o) => o.checkId),
    bootstrap: run.outstandingBootstrap.map((o) => o.checkId),
    lastStarted: newest?.checkId ?? null,
    settled: run.endedCount,
    selected: run.selected?.length ?? null,
  };
}

/**
 * Record a hung run: its `hung` progress record and its `check-pass-hung`
 * report. Returns the line the worker prints before the kill.
 */
export async function recordHungRun(
  args: HangWatchData & { heldMs: number; silentMs: number },
): Promise<{ consoleLine: string }> {
  const nativeStack = await captureNativeStack(args.pid);
  const payload = CheckPassHungPayloadSchema.parse({
    worktree: args.worktree,
    runId: args.runId,
    pid: args.pid,
    transcript: args.transcript,
    heldMs: args.heldMs,
    silentMs: args.silentMs,
    elapsedMs: Date.now() - args.openedAt,
    ...inFlight(args.runId),
    nativeStack,
  } satisfies CheckPassHungPayload);
  writeHungRecord({
    runId: args.runId,
    pid: args.pid,
    worktree: args.worktree,
    heldMs: args.heldMs,
    silentMs: args.silentMs,
    sampleFile: nativeStack.captured ? nativeStack.file : null,
  });
  const message = checkPassHungMessage(payload);
  const filed = await fileReportFromProcess({
    kind: CHECK_PASS_HUNG_KIND,
    message,
    data: payload,
  });
  const report =
    filed.outcome === "written"
      ? "report filed (Debug → Reports)"
      : filed.outcome === "refused"
        ? `report NOT filed: the outbox is full (${filed.pending} pending)`
        : `report NOT filed: ${String(filed.error)}`;
  const stack = nativeStack.captured
    ? `native stack: ${nativeStack.file}`
    : `native stack not captured (${nativeStack.reason})`;
  return {
    consoleLine:
      `✗ ${message}. The main thread ran no timer for ${Math.round(args.silentMs / 1000)} s ` +
      `while holding its core ${Math.round(args.heldMs / 1000)} s — the hang watch killed this pass ` +
      `rather than leave it running forever. ${stack}; ${report}; run ${args.runId}.`,
  };
}
