import {
  useLiveRow,
  type LiveRowResult,
} from "@plugins/network/plugins/live/web";
import { useEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { InvestigateAction } from "@plugins/primitives/plugins/launch/plugins/investigate/web";
import {
  BUILD_CATEGORY_ID,
  type BuildRun,
  buildHistory,
} from "@plugins/build/core";
import { buildStatusOf } from "@plugins/build/plugins/build-status/core";
import { getBuildRunLogs } from "@plugins/build/plugins/build-logs/core";
import { BUILD_RUN_KIND } from "@plugins/build/plugins/run-ledger/core";
import { runSubject } from "@plugins/runs/core";

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
  return <BuildFixButton runId={runId} run={run.row} />;
}

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

function BuildFixButton({ runId, run }: { runId: string; run: BuildRun }) {
  const logsResult = useEndpoint(getBuildRunLogs, { id: runId });
  const logs = logsResult.data;

  // The same subject the merged runs list files a failed build under, so the
  // two reach one task.
  return (
    <InvestigateAction
      presentation="button"
      noun="build"
      subject={runSubject({ kind: BUILD_RUN_KIND, id: runId })}
      categoryId={BUILD_CATEGORY_ID}
      description="Launch an agent to diagnose and fix the failing build — briefed with the build's info and the failed steps' output."
      placeholder="Extra context (optional) — e.g. what changed, suspected cause…"
      brief={(userText) => {
        const failedSteps = logs?.steps.filter((s) => !s.success) ?? [];
        const errorText = failedSteps
          .map((s) => {
            const lines = s.lines.map((l) => l.text).join("\n");
            return `Step "${s.label}" failed:\n${lines}`;
          })
          .join("\n\n");

        const parts = ["Investigate and fix this build failure on main."];
        parts.push(`Build info:\n${formatBuildInfo(run)}`);
        if (errorText) parts.push(`Build output:\n\n${errorText}`);
        if (userText.trim())
          parts.push(`Additional context: ${userText.trim()}`);
        return parts.join("\n\n");
      }}
    />
  );
}
