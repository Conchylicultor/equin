import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { readFile, stat } from "@plugins/packages/plugins/timed-fs/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import {
  readRunTerminal,
  type RunTerminal,
} from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import { BUILD_RUN_KIND_ID } from "@plugins/build/plugins/run-ledger/core";
import {
  parseStepBlocks,
  type TranscriptSegment,
} from "@plugins/framework/plugins/cli/plugins/op-runtime/core";
import {
  buildLogLineKey,
  type BuildLogLine,
  type BuildLogStep,
  type BuildLogStepStatus,
} from "../../core/run-logs";

/** Read a file, or null when it is not there. Any other fs error is a real fault. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** One build run's log as the live value serves it: its steps and its lines. */
export interface BuildRunLog {
  steps: BuildLogStep[];
  /** Every line of every step, in run order, numbered over the whole run. */
  lines: BuildLogLine[];
}

/** The label of a stretch of output printed outside any step block. */
const OUTPUT_LABEL = "output";

/**
 * Each segment's status. A printed block carries its own verdict. An `output`
 * stretch is `ok` — except the LAST segment, which is where the run is (no
 * marker: `running`) or where it ended: a failed run (non-zero marker) whose
 * blocks all passed failed outside them, in its last stretch (a backend that
 * never answered, a crash) — so that stretch is the failure, and the Fix brief
 * has it to quote.
 */
function segmentStatuses(
  segments: readonly TranscriptSegment[],
  terminal: RunTerminal | null,
): BuildLogStepStatus[] {
  const statuses = segments.map((seg): BuildLogStepStatus =>
    seg.kind === "step" && !seg.success ? "failed" : "ok",
  );
  const last = segments.length - 1;
  if (last < 0) return statuses;
  if (terminal === null) {
    statuses[last] = "running";
  } else if (terminal.exitCode !== 0 && !statuses.includes("failed")) {
    statuses[last] = "failed";
  }
  return statuses;
}

/** The segments' lines numbered over the whole run, each naming its step by position. */
function flattenSegments(
  segments: readonly TranscriptSegment[],
  terminal: RunTerminal | null,
): BuildRunLog {
  const statuses = segmentStatuses(segments, terminal);
  const lines: BuildLogLine[] = [];
  segments.forEach((seg, index) => {
    for (const text of seg.lines) {
      lines.push({
        n: buildLogLineKey(lines.length + 1),
        step: index,
        text,
        // Every line reads as `stdout`: a supervised child's stdout and stderr
        // share one descriptor, so the interleaving survives and the
        // classification does not.
        stream: "stdout",
      });
    }
  });
  return {
    steps: segments.map((seg, index) => ({
      label: seg.kind === "step" ? seg.label : OUTPUT_LABEL,
      status: statuses[index] ?? "ok",
      durationMs: seg.kind === "step" ? seg.durationMs : null,
      lines: seg.lines.length,
    })),
    lines,
  };
}

/**
 * One build run's log: its supervised-run transcript cut into its printed step
 * blocks and the output between them, with the exit marker's verdict — else
 * `null`, no transcript on disk (reaped by the prune, or a hand-run build from
 * before every build recorded one), which the value refuses as `missing`.
 *
 * Exported apart from the served value because it is the whole decision and it
 * is pure over two files on disk — which is what the tests beside it drive.
 */
export async function readBuildRunLog(
  buildId: string,
): Promise<BuildRunLog | null> {
  // The marker first: a run that ends between the two reads then reads as
  // still running over its complete transcript, never as ended over a partial
  // one.
  const terminal = await readRunTerminal(BUILD_RUN_KIND_ID, buildId);
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
  return flattenSegments(parseStepBlocks(lines), terminal);
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

/** The `(size, mtime)` of both files the log is read from. */
async function logSignature(buildId: string): Promise<string> {
  const ns = runtimeNamespace();
  const parts = await Promise.all([
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
 * {@link readBuildRunLog}, memoized on the two files' `(size, mtime)`: every
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
