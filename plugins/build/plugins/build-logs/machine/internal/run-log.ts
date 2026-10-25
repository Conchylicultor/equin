import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import { readRunTerminal } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import { BUILD_RUN_KIND_ID } from "@plugins/build/plugins/run-ledger/core";
import {
  buildLogLineKey,
  type BuildLogLine,
  type BuildLogStep,
} from "../../core/run-logs";

const StepLogSchema = z.object({
  id: z.string(),
  label: z.string(),
  lines: z.array(
    z.object({ text: z.string(), stream: z.enum(["stdout", "stderr"]) }),
  ),
  durationMs: z.number(),
  success: z.boolean(),
});
/** One step as the CLI writes it — its lines inline. */
type StepLog = z.infer<typeof StepLogSchema>;

/**
 * The build's own step transcript, written by the CLI from INSIDE the build.
 *
 * This is the half of `build-logs-<id>.json` that did NOT move to the
 * supervised-run primitive, and the distinction is worth stating because the
 * file did two jobs. Its `exitCode` + `finishedAt` were the terminal record the
 * backend recovered a killed build's outcome from; that job is now the exit
 * marker's, written by the shim for ANY command rather than by a CLI that
 * remembers to. Its `steps` are a structure only the build itself can know —
 * which phase each line belongs to, how long it took, whether it passed — so
 * there is nothing to move: the CLI already writes it, at every terminal it can
 * reach, and the primitive changes nothing about that.
 */
const BuildLogsFileSchema = z.object({ steps: z.array(StepLogSchema) });

/** Read a file, or null when it is not there. Any other fs error is a real fault. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function readStepArtifact(buildId: string): Promise<StepLog[] | null> {
  const raw = await readIfPresent(
    worktreeArtifacts.buildLogs(runtimeNamespace(), buildId),
  );
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    // A truncated artifact is not worth taking the pane down for — it was
    // written by a process that no longer exists and cannot be repaired. The
    // transcript fallback below still has the raw output.
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
  // Well-formed JSON of the wrong shape is a writer defect: loud.
  return BuildLogsFileSchema.parse(json).steps;
}

/** The synthetic step's id, and the label the pane shows above the raw block. */
const RAW_STEP_ID = "raw";

/**
 * The whole build's output as ONE block, read from its supervised-run
 * transcript.
 *
 * **This replaces `recoverBuildArtifacts`, and replacing it is a strict gain.**
 * That helper was the SIGKILL backstop: a build hard-killed before its exit
 * handler ran writes no step artifact, so the backend reconstructed a one-step
 * stand-in from the lines it had captured off the child's pipe. Under the
 * supervised-run primitive there is no pipe — and there no longer needs to be,
 * because the child writes its merged output straight into the transcript file.
 * That file exists for EVERY build, including one whose spawning backend also
 * died, which is the case the old backstop could never cover: it required the
 * parent to have survived, and a build restarts its parent.
 *
 * So the recovery moved from the WRITE path to the READ path. Nothing
 * synthesises an artifact any more; this reads the two files the primitive
 * already owns and renders the same single honest block — the CLI's per-step
 * structure genuinely died with it, and inventing a shape it never reported
 * would be worse.
 *
 * `success` comes from the exit marker rather than being assumed, so a
 * hard-killed build's block is not shown with a green tick. No marker at all
 * (the SIGKILL case itself) is not a success.
 *
 * The `build-<id>.log` half of the old recovery is deliberately NOT replaced.
 * Its only purpose was to make the CLI's `Full output:` pointer resolve — and a
 * build that never ran its exit handler printed no verdict, so nothing points at
 * it.
 */
async function readTranscriptAsStep(buildId: string): Promise<StepLog | null> {
  const text = await readIfPresent(
    worktreeArtifacts.runTranscript(
      runtimeNamespace(),
      BUILD_RUN_KIND_ID,
      buildId,
    ),
  );
  if (text === null) return null;
  const lines = text.split("\n");
  // A transcript ends in a newline unless the child died mid-line, so the last
  // piece is usually empty — and a genuinely unterminated last line is the one
  // most worth keeping, so it is only the empty case that is dropped.
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return null;
  const terminal = readRunTerminal(BUILD_RUN_KIND_ID, buildId);
  return {
    id: RAW_STEP_ID,
    label: "Build Output",
    // Every line reads as `stdout`: a supervised child's stdout and stderr share
    // one descriptor, so the interleaving survives and the classification does
    // not. The live view of the same bytes already says `stdout`.
    lines: lines.map((text) => ({ text, stream: "stdout" as const })),
    // Unknown. The step artifact is where per-step timings live; a number
    // invented here would be rendered beside the label as if it were measured.
    durationMs: 0,
    success: terminal?.exitCode === 0,
  };
}

/** One build run's log as the live value serves it: its steps and its lines. */
export interface BuildRunLog {
  steps: BuildLogStep[];
  /** Every line of every step, in run order, numbered over the whole run. */
  lines: BuildLogLine[];
}

/** The steps' lines numbered over the whole run, each naming its step by position. */
function flattenSteps(steps: readonly StepLog[]): BuildRunLog {
  const lines: BuildLogLine[] = [];
  steps.forEach((step, index) => {
    for (const line of step.lines) {
      lines.push({
        n: buildLogLineKey(lines.length + 1),
        step: index,
        text: line.text,
        stream: line.stream,
      });
    }
  });
  return {
    steps: steps.map((s) => ({
      id: s.id,
      label: s.label,
      durationMs: s.durationMs,
      success: s.success,
      lines: s.lines.length,
    })),
    lines,
  };
}

/**
 * One build run's log: the CLI's own step transcript when it wrote one with any
 * step, else the raw supervised-run transcript as a single step, else `null` —
 * no log on disk (a run that has not written a line yet, a hand-run build
 * before its step log lands, or one the prune reaped), which the value refuses
 * as `missing` and the pane answers with the live log channel.
 *
 * Exported apart from the served value because it is the whole decision and it
 * is pure over three files on disk — which is what the tests beside it drive.
 */
export async function readBuildRunLog(
  buildId: string,
): Promise<BuildRunLog | null> {
  const artifact = await readStepArtifact(buildId);
  if (artifact !== null && artifact.length > 0) return flattenSteps(artifact);
  const raw = await readTranscriptAsStep(buildId);
  return raw === null ? null : flattenSteps([raw]);
}

/** A file's `(size, mtime)`, or `-` when it is not there. */
async function statSignature(path: string): Promise<string> {
  try {
    const s = await stat(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "-";
    throw err;
  }
}

/** The `(size, mtime)` of every file the log is read from. */
async function logSignature(buildId: string): Promise<string> {
  const ns = runtimeNamespace();
  const parts = await Promise.all([
    statSignature(worktreeArtifacts.buildLogs(ns, buildId)),
    statSignature(
      worktreeArtifacts.runTranscript(ns, BUILD_RUN_KIND_ID, buildId),
    ),
    statSignature(
      worktreeArtifacts.runTerminal(ns, BUILD_RUN_KIND_ID, buildId),
    ),
  ]);
  return parts.join("|");
}

const held = new Map<string, { signature: string; log: BuildRunLog | null }>();

/**
 * {@link readBuildRunLog}, memoized on the three files' `(size, mtime)`: every
 * page of one change (and the meta) reads them once. The stats are taken BEFORE
 * the read, so a write landing in between leaves the held signature older than
 * the bytes and the next call re-reads — never the reverse.
 */
export async function heldBuildRunLog(
  buildId: string,
): Promise<BuildRunLog | null> {
  const signature = await logSignature(buildId);
  const prior = held.get(buildId);
  if (prior?.signature === signature) return prior.log;
  const log = await readBuildRunLog(buildId);
  held.set(buildId, { signature, log });
  return log;
}

/** Drop a run's memoized log — it is no longer read. */
export function forgetBuildRunLog(buildId: string): void {
  held.delete(buildId);
}
