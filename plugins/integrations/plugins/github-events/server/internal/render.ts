import type { ReportRow } from "@plugins/reports/server";
import {
  githubRunFailedMessage,
  type GitHubRunFailedPayload,
} from "../../core";

// The task body, kept apart from the `ReportKind` wiring (kind.ts) so it is
// testable without evaluating the reports plugin's server barrel. `remedy` is
// the watch's own advice (its owner's re-publish command), already resolved.

export function renderGitHubRunFailedTask(
  row: Pick<ReportRow, "count" | "firstSeenAt" | "lastSeenAt">,
  d: GitHubRunFailedPayload,
  remedy: readonly string[],
): { title: string; description: string } {
  const lines: string[] = [
    `The \`${d.workflow}\` workflow of \`${d.repo}\` (${d.workflowName}) ` +
      `${d.conclusion === "timed_out" ? "timed out" : "failed"} on \`${d.head}\` ` +
      `(${d.event}, commit \`${d.sha.slice(0, 9)}\`, attempt ${d.attempt}).`,
    "",
    `**Run:** ${d.url}`,
    "",
  ];
  if (d.failedJobs.length === 0) {
    lines.push(
      "**Failed jobs:** none recorded — GitHub sent no failed job for this run (read the log below).",
    );
  } else {
    lines.push("**Failed jobs:**");
    for (const job of d.failedJobs) {
      const steps =
        job.failedSteps.length === 0
          ? ""
          : ` — step${job.failedSteps.length === 1 ? "" : "s"} ${job.failedSteps.map((s) => `\`${s}\``).join(", ")}`;
      lines.push(`- [${job.name}](${job.url}) (${job.conclusion})${steps}`);
    }
  }
  lines.push(
    "",
    "**What to do:**",
    `1. Read the failure: \`gh run view ${d.runId} -R ${d.repo} --log-failed\`.`,
    "2. Fix the cause where it lives (this repo's code, or the workflow), not by re-running until it passes.",
  );
  remedy.forEach((line, i) => lines.push(`${i + 3}. ${line}`));
  lines.push(
    "",
    `**Occurrences:** ${row.count}`,
    `**First seen:** ${row.firstSeenAt.toISOString()}`,
    `**Last seen:** ${row.lastSeenAt.toISOString()}`,
  );
  return {
    title: `[github-run-failed] ${githubRunFailedMessage(d)}`,
    description: lines.join("\n"),
  };
}
