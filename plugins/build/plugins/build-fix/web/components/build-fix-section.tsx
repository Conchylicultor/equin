import {
  useLive,
  useLiveRow,
  type LiveListResult,
  type LiveRowResult,
  type LiveUnavailable,
} from "@plugins/network/plugins/live/web";
import type {
  ResourceError,
  ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { InvestigateAction } from "@plugins/primitives/plugins/launch/plugins/investigate/web";
import {
  BUILD_CATEGORY_ID,
  type BuildRun,
  buildHistory,
} from "@plugins/build/core";
import { buildStatusOf } from "@plugins/build/plugins/build-status/core";
import {
  buildRunLogs,
  type BuildLogLine,
  type BuildRunLogsMeta,
  type BuildRunLogsRefusal,
} from "@plugins/build/plugins/build-logs/core";
import { BUILD_RUN_KIND } from "@plugins/build/plugins/run-ledger/core";
import { runSubject } from "@plugins/runs/core";
import { z } from "zod";
import type {
  NotificationActionControlProps,
  NotificationActionKind,
} from "@plugins/shell/plugins/notifications/web";
import type { InvestigatePresentation } from "@plugins/primitives/plugins/launch/plugins/investigate/web";

/**
 * The run, by id: loading (or failed), then found or determinately absent (`found: false`
 * means this namespace has no such run). A point read, so a run older than the
 * newest 50 the history window holds is still found.
 */
function useBuildRun(runId: string): LiveRowResult<BuildRun> {
  return useLiveRow(buildHistory, runId);
}

/**
 * The section exists only for a build that actually failed — a green run has
 * nothing to fix. Declared as the contribution's `useAvailable` rather than a
 * `return null` in the content: the host paints the card before it reaches the
 * content, so a null here would leave a "Fix" bar over nothing.
 *
 * `failed` is the ONLY status with a defect to hand an agent — a build that ran
 * to a verdict and gave a bad one. A superseded run's tree was replaced
 * mid-build, so its steps straddle two commits and describe neither; an
 * interrupted or externally-killed run never reached a verdict at all. Offering
 * to investigate any of those sends an agent after a bug that does not exist.
 */
export function useBuildFailed({ runId }: { runId: string }): boolean {
  const run = useBuildRun(runId);
  // Unavailable until the run is known: offering a fix before knowing the build
  // failed would be a claim the data may not back. A failed read says so in
  // the run's own detail (build-info), not by offering a fix here.
  switch (run.status) {
    case "loading":
    case "error":
      return false;
    case "ready":
      return run.found && buildStatusOf(run.row) === "failed";
  }
}

/**
 * The section's whole content: one button. It rides the header as the
 * contribution's `actions`, so the card is a single row with the action on it —
 * there is no body, and therefore no chevron opening onto one button.
 */
export function BuildFixAction({ runId }: { runId: string }) {
  const run = useBuildRun(runId);
  // `useAvailable` already gated on a failed run; this only narrows the type.
  if (run.status === "loading" || run.status === "error" || !run.found) {
    return null;
  }
  return <BuildFixButton runId={runId} run={run.row} presentation="button" />;
}

const FixPayloadSchema = z.object({ runId: z.string() });

/**
 * A "Build failed" notification's Fix: the same investigate launch as the
 * run's own Fix section, drawn as the notification's one action. Nothing
 * until the run is known (a notification outliving its run's row offers no
 * Fix: there is nothing left to brief an agent with).
 */
function BuildFixNotificationControl({
  payload,
  label,
}: NotificationActionControlProps) {
  const { runId } = FixPayloadSchema.parse(payload);
  const run = useBuildRun(runId);
  if (run.status === "loading" || run.status === "error" || !run.found) {
    return null;
  }
  return (
    <BuildFixButton
      runId={runId}
      run={run.row}
      presentation={{ notification: label }}
    />
  );
}

/** The `fix-build` notification action kind (`payload: { runId }`). */
export const fixBuildAction: NotificationActionKind = {
  kind: "fix-build",
  label: "Fix",
  Control: BuildFixNotificationControl,
};

function formatBuildInfo(run: BuildRun): string {
  const lines: string[] = [];
  lines.push(`Build ID: ${run.id}`);
  if (run.commitHash) lines.push(`Commit: ${run.commitHash}`);
  lines.push(`Exit code: ${run.exitCode}`);
  if (run.finishedAt) {
    const durationMs =
      new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
    const durationSec = Math.round(durationMs / 1000);
    lines.push(`Duration: ${durationSec}s`);
  }
  return lines.join("\n");
}

/**
 * The most lines of failed-step output the brief carries: the newest lines of
 * the run (one page of `build.run-logs`, newest first), which for a failed
 * build are its failing step's tail — where the error is.
 */
const BRIEF_TAIL_LINES = 500;

/** What the brief says of a log read that has not answered with data. */
function unreadNote(
  read:
    | { status: "loading" }
    | { status: "error"; error: ResourceError<BuildRunLogsRefusal> }
    | LiveUnavailable,
): string | null {
  // A host without the computer has no run files to read.
  if (read.status === "unavailable")
    return `(The build output cannot be read here: ${read.message})`;
  if (read.status === "loading")
    return "(The build output had not loaded yet when this was filed — read the run's logs.)";
  // A run with no log on disk has no output to give.
  if (read.error.kind === "refused" && read.error.code === "missing")
    return null;
  return `(The build output could not be read: ${read.error.message})`;
}

/**
 * The brief's "Build output" part, from the run's log as read so far: the
 * failed steps' lines among the newest {@link BRIEF_TAIL_LINES}, in run order,
 * under each step's name. A read that has not answered (or failed) says so in
 * the brief rather than passing for a build with no output; a run with no log
 * on disk (`missing`) has none to give.
 */
function buildOutputOf(
  meta: ResourceResult<BuildRunLogsMeta, BuildRunLogsRefusal> | LiveUnavailable,
  tail: LiveListResult<BuildLogLine, BuildRunLogsRefusal> | LiveUnavailable,
): string | null {
  if (
    meta.status === "loading" ||
    meta.status === "error" ||
    meta.status === "unavailable"
  )
    return unreadNote(meta);
  if (
    tail.status === "loading" ||
    tail.status === "error" ||
    tail.status === "unavailable"
  )
    return unreadNote(tail);
  const steps = meta.data.steps;
  const failed = tail.data
    .filter((l) => steps[l.step]?.success === false)
    .reverse();
  if (failed.length === 0) return null;
  const blocks: string[] = [];
  let current: { step: number; lines: string[] } | null = null;
  for (const line of failed) {
    if (current === null || current.step !== line.step) {
      if (current !== null) blocks.push(blockText(current));
      current = { step: line.step, lines: [] };
    }
    current.lines.push(line.text);
  }
  if (current !== null) blocks.push(blockText(current));
  const truncated = tail.data.length >= BRIEF_TAIL_LINES;
  return (
    (truncated ? `(The last ${BRIEF_TAIL_LINES} lines of the run.)\n\n` : "") +
    blocks.join("\n\n")
  );

  function blockText(block: { step: number; lines: string[] }): string {
    return `Step "${steps[block.step]?.label}" failed:\n${block.lines.join("\n")}`;
  }
}

function BuildFixButton({
  runId,
  run,
  presentation,
}: {
  runId: string;
  run: BuildRun;
  presentation: InvestigatePresentation;
}) {
  const meta = useLive(buildRunLogs.meta, { id: runId });
  const tail = useLive(
    buildRunLogs,
    { id: runId },
    { limit: BRIEF_TAIL_LINES },
  );

  // The same subject the merged runs list files a failed build under, so the
  // two reach one task.
  return (
    <InvestigateAction
      presentation={presentation}
      noun="build"
      subject={runSubject({ kind: BUILD_RUN_KIND, id: runId })}
      categoryId={BUILD_CATEGORY_ID}
      description="Launch an agent to diagnose and fix the failing build — briefed with the build's info and the failed steps' output."
      placeholder="Extra context (optional) — e.g. what changed, suspected cause…"
      brief={(userText) => {
        const output = buildOutputOf(meta, tail);
        const parts = ["Investigate and fix this build failure on main."];
        parts.push(`Build info:\n${formatBuildInfo(run)}`);
        if (output !== null) parts.push(`Build output:\n\n${output}`);
        if (userText.trim())
          parts.push(`Additional context: ${userText.trim()}`);
        return parts.join("\n\n");
      }}
    />
  );
}
